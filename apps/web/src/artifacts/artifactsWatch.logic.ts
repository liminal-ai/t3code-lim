// Fork-only (artifacts): the client side of `POST /api/artifacts/watch`, an
// NDJSON stream of `{ready}`, `{change}`, `{resync}` and `{}` (heartbeat)
// frames. It reconnects with backoff, and treats a silent stream as dead (the
// server sends a heartbeat every 20 s). Every `{ready}` is reported as a resync:
// changes made while the stream was down, or before it first opened, weren't
// delivered, so whoever shows artifacts re-reads them.
import { type LimArtifactChange, LimArtifactWatchFrame } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ArtifactsError, readArtifactsError } from "./artifactsClient";

export type ArtifactWatchEvent =
  | { readonly type: "change"; readonly change: LimArtifactChange }
  | { readonly type: "resync" };

export type ArtifactWatchStatus = "connecting" | "live" | "retrying" | "failed";

const decodeFrame = Schema.decodeUnknownOption(LimArtifactWatchFrame);

/** Complete lines from `buffer`, and the partial line left over. */
export function splitLines(buffer: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}

/** One frame as the event it means, or `null` for a heartbeat or a line that isn't a frame. */
export function frameEvent(line: string): ArtifactWatchEvent | { readonly type: "ready" } | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const frame = decodeFrame(json);
  if (frame._tag === "None") return null;
  const value = frame.value;
  if ("ready" in value) return { type: "ready" };
  if ("change" in value) return { type: "change", change: value.change };
  if ("resync" in value) return value.resync ? { type: "resync" } : null;
  return null;
}

/** Refusals that retrying won't fix: auth, a server without the routes, a bad request. */
export const isPermanentWatchFailure = (error: unknown): boolean =>
  error instanceof ArtifactsError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

export interface ArtifactWatchOptions {
  readonly open: (signal: AbortSignal) => Promise<Response>;
  readonly onEvent: (event: ArtifactWatchEvent) => void;
  readonly onStatus?: (status: ArtifactWatchStatus, error?: Error) => void;
  /** No bytes for this long means the connection is dead. */
  readonly idleTimeoutMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/** Watches until the returned function is called. */
export function watchArtifacts(options: ArtifactWatchOptions): () => void {
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const minBackoffMs = options.minBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  let stopped = false;
  let controller: AbortController | undefined;
  let wake: (() => void) | undefined;
  let backoff = minBackoffMs;

  const status = (next: ArtifactWatchStatus, error?: Error) => {
    if (!stopped) options.onStatus?.(next, error);
  };

  const connectOnce = async (): Promise<"retry" | "stop"> => {
    const current = new AbortController();
    controller = current;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => current.abort(), idleTimeoutMs);
    };
    try {
      resetIdle();
      const response = await options.open(current.signal);
      if (!response.ok || !response.body) throw await readArtifactsError(response);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        resetIdle();
        const split = splitLines(buffer + value);
        buffer = split.rest;
        for (const line of split.lines) {
          const event = frameEvent(line);
          if (event === null || stopped) continue;
          if (event.type === "ready") {
            backoff = minBackoffMs;
            status("live");
            options.onEvent({ type: "resync" });
          } else {
            options.onEvent(event);
          }
        }
      }
    } catch (error) {
      if (stopped) return "stop";
      if (isPermanentWatchFailure(error)) {
        status("failed", error as Error);
        return "stop";
      }
    } finally {
      clearTimeout(idle);
    }
    return stopped ? "stop" : "retry";
  };

  void (async () => {
    status("connecting");
    for (;;) {
      if ((await connectOnce()) === "stop") return;
      status("retrying");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (stopped) return;
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  })();

  return () => {
    stopped = true;
    controller?.abort();
    wake?.();
  };
}

/**
 * Runs `run` now, or once more after the current run if one is going: any number
 * of requests while it runs make one more run, never overlapping ones.
 */
export function coalesce(run: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        again = false;
        try {
          await run();
        } catch {
          // The run reports its own failures.
        }
      } while (again);
      running = false;
    })();
  };
}
