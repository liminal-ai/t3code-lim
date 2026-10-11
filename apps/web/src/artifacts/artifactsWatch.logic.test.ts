import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ArtifactWatchEvent,
  type ArtifactWatchStatus,
  coalesce,
  frameEvent,
  splitLines,
  watchArtifacts,
} from "./artifactsWatch.logic";

const change = {
  seq: 7,
  artifactId: "01JA7Q3F2M0000000000000000",
  at: "2026-10-10T00:00:00.000Z",
  action: "check",
  actor: { kind: "agent", id: "thread-alder", name: "Alder" },
  summary: "checked 'Compact chip starts unarmed'",
  itemId: "b3",
  revision: "r2",
};

/** A streaming response the test writes to; aborting its signal errors the body, as fetch does. */
function streamResponse(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal.addEventListener("abort", () =>
    controller.error(new DOMException("aborted", "AbortError")),
  );
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200 }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

function harness(
  options: { readonly idleTimeoutMs?: number; readonly minBackoffMs?: number } = {},
) {
  const streams: Array<ReturnType<typeof streamResponse>> = [];
  const signals: AbortSignal[] = [];
  const events: ArtifactWatchEvent[] = [];
  const statuses: ArtifactWatchStatus[] = [];
  const failures: Array<Response | Error> = [];
  const open = vi.fn(async (signal: AbortSignal) => {
    signals.push(signal);
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const stream = streamResponse(signal);
    streams.push(stream);
    return stream.response;
  });
  const stop = watchArtifacts({
    open,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    minBackoffMs: options.minBackoffMs ?? 1,
    maxBackoffMs: Math.max(4, options.minBackoffMs ?? 1),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  });
  return {
    open,
    streams,
    signals,
    events,
    statuses,
    stop,
    /** The next connects fail like this, in order. */
    failNextWith: (...next: Array<Response | Error>) => {
      failures.push(...next);
    },
  };
}

describe("frames", () => {
  it("keeps a partial line for the next chunk", () => {
    expect(splitLines('{"ready":{"seq":1}}\n{"chan')).toEqual({
      lines: ['{"ready":{"seq":1}}'],
      rest: '{"chan',
    });
    expect(splitLines("{}\n\n")).toEqual({ lines: ["{}"], rest: "" });
  });

  it("reads each frame kind, and ignores heartbeats and junk", () => {
    expect(frameEvent('{"ready":{"seq":3}}')).toEqual({ type: "ready" });
    expect(frameEvent(JSON.stringify({ change }))).toEqual({ type: "change", change });
    expect(frameEvent('{"resync":true}')).toEqual({ type: "resync" });
    expect(frameEvent("{}")).toBeNull();
    expect(frameEvent("not json")).toBeNull();
  });
});

describe("watchArtifacts", () => {
  it("reports ready as a resync, then each change, across chunk boundaries", async () => {
    const watch = harness();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    const line = `${JSON.stringify({ change })}\n`;
    watch.streams[0]!.push(`{"ready":{"seq":6}}\n${line.slice(0, 20)}`);
    watch.streams[0]!.push(`${line.slice(20)}{}\n{"resync":true}\n`);
    await vi.waitFor(() => expect(watch.events).toHaveLength(3));
    expect(watch.events).toEqual([
      { type: "resync" },
      { type: "change", change },
      { type: "resync" },
    ]);
    expect(watch.statuses).toEqual(["connecting", "live"]);
    watch.stop();
  });

  it("reconnects when the stream ends, and resyncs on the new stream's ready", async () => {
    const watch = harness();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.streams[0]!.push('{"ready":{"seq":1}}\n');
    watch.streams[0]!.end();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(2));
    watch.streams[1]!.push('{"ready":{"seq":5}}\n');
    await vi.waitFor(() => expect(watch.events).toHaveLength(2));
    expect(watch.events).toEqual([{ type: "resync" }, { type: "resync" }]);
    expect(watch.statuses).toEqual(["connecting", "live", "retrying", "live"]);
    watch.stop();
  });

  it("retries after a network error or a 503", async () => {
    const watch = harness();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.failNextWith(
      new TypeError("fetch failed"),
      new Response(JSON.stringify({ error: { message: "store down", code: "unavailable" } }), {
        status: 503,
      }),
    );
    watch.streams[0]!.end();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(2));
    expect(watch.open).toHaveBeenCalledTimes(4);
    watch.stop();
  });

  it("stops on a refusal retrying won't fix", async () => {
    const watch = harness();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.failNextWith(
      new Response(JSON.stringify({ error: { message: "no session", code: "unauthorized" } }), {
        status: 401,
      }),
    );
    watch.streams[0]!.end();
    await vi.waitFor(() => expect(watch.statuses.at(-1)).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watch.open).toHaveBeenCalledTimes(2);
  });

  it("treats a silent stream as dead and reconnects", async () => {
    const watch = harness({ idleTimeoutMs: 20 });
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.streams[0]!.push('{"ready":{"seq":1}}\n');
    await vi.waitFor(() => expect(watch.streams.length).toBeGreaterThan(1));
    expect(watch.signals[0]!.aborted).toBe(true);
    expect(watch.statuses).toContain("retrying");
    watch.stop();
  });

  it("keeps a stream whose heartbeats keep coming", async () => {
    const watch = harness({ idleTimeoutMs: 60 });
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    for (let beat = 0; beat < 8; beat++) {
      watch.streams[0]!.push("{}\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(watch.signals[0]!.aborted).toBe(false);
    expect(watch.open).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("doesn't reconnect when stopped while waiting to retry", async () => {
    const watch = harness({ minBackoffMs: 50 });
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.streams[0]!.end();
    await vi.waitFor(() => expect(watch.statuses).toContain("retrying"));
    watch.stop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(watch.open).toHaveBeenCalledTimes(1);
  });

  it("stops for good when told to", async () => {
    const watch = harness();
    await vi.waitFor(() => expect(watch.streams).toHaveLength(1));
    watch.stop();
    expect(watch.signals[0]!.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watch.open).toHaveBeenCalledTimes(1);
    expect(watch.events).toEqual([]);
  });
});

describe("coalesce", () => {
  it("turns calls made during a run into exactly one more run, never overlapping", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });
    const trigger = coalesce(run);
    trigger();
    trigger();
    trigger();
    expect(run).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    trigger();
    expect(run).toHaveBeenCalledTimes(3);
    releases.shift()!();
  });
});
