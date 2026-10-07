// Fork-only (agent comms): the page's client for /api/comms/* on this T3
// server. Calls are one POST each; every live query rides one streaming POST
// (/api/comms/watch, NDJSON frames), reopened whenever the watched set
// changes. The T3 session cookie is the credential; the server adds the comms
// admin token. Ported from agent-comms' web view (apps/web/src/lib/backend.tsx).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";

import type { CommsConfig } from "./commsTypes";

export class CommsError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "CommsError";
    this.status = status;
    this.data = data;
  }
}

type Args = Readonly<Record<string, unknown>>;

interface EntryState {
  readonly value?: unknown;
  readonly error?: Error;
}

interface Entry {
  readonly name: string;
  readonly args: Args;
  state: EntryState | undefined;
  readonly listeners: Set<() => void>;
}

const url = (path: string) => resolvePrimaryEnvironmentHttpUrl(`/api/comms${path}`);

async function readError(response: Response): Promise<CommsError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; data?: unknown };
  };
  return new CommsError(
    body.error?.message ?? `comms request failed (${response.status})`,
    response.status,
    body.error?.data,
  );
}

class CommsClient {
  private readonly entries = new Map<string, Entry>();
  private stream: AbortController | undefined;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff = 250;

  async call(kind: "query" | "mutation", name: string, args: Args = {}): Promise<unknown> {
    const response = await fetch(url("/call"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, args }),
    });
    if (!response.ok) throw await readError(response);
    return ((await response.json()) as { value?: unknown }).value;
  }

  entry(key: string, name: string, args: Args): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { name, args, state: undefined, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  listen(key: string, entry: Entry, onChange: () => void): () => void {
    entry.listeners.add(onChange);
    if (entry.listeners.size === 1) this.reopen();
    return () => {
      entry.listeners.delete(onChange);
      // Kept briefly, so a re-render that resubscribes doesn't churn the stream.
      setTimeout(() => {
        if (entry.listeners.size === 0 && this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.reopen();
        }
      }, 1_000);
    };
  }

  /** The watched set changed: one new stream carries all of it. */
  private reopen(): void {
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => void this.open(), 10);
  }

  private async open(): Promise<void> {
    this.stream?.abort();
    const live = [...this.entries].filter(([, entry]) => entry.listeners.size > 0);
    if (live.length === 0) return;
    const controller = new AbortController();
    this.stream = controller;
    const queries = live.map(([id, entry]) => ({ id, name: entry.name, args: entry.args }));
    try {
      const response = await fetch(url("/watch"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw await readError(response);
      this.backoff = 250;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) this.deliver(JSON.parse(line) as WatchFrame);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // Configuration and auth refusals won't heal on retry: show them.
      if (error instanceof CommsError && error.status !== 502 && error.status < 500) {
        for (const [, entry] of live) this.set(entry, { error });
        return;
      }
    }
    if (this.stream === controller && !controller.signal.aborted) {
      this.backoff = Math.min(this.backoff * 2, 10_000);
      this.reopenTimer = setTimeout(() => void this.open(), this.backoff);
    }
  }

  private deliver(frame: WatchFrame): void {
    if (!frame.id) return; // heartbeat
    const entry = this.entries.get(frame.id);
    if (!entry) return;
    this.set(
      entry,
      frame.error
        ? { error: new CommsError(frame.error.message, 400, frame.error.data) }
        : { value: frame.value },
    );
  }

  private set(entry: Entry, state: EntryState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }
}

interface WatchFrame {
  readonly id?: string;
  readonly value?: unknown;
  readonly error?: { readonly message: string; readonly data?: unknown };
}

const client = new CommsClient();

export const commsCall = (name: string, args?: Args) => client.call("mutation", name, args);

/** A live comms query. `undefined` while loading; `skip` watches nothing. */
export function useCommsQuery<T>(
  name: string,
  args: Args | "skip" = {},
): { readonly data: T | undefined; readonly error: Error | undefined } {
  const skip = args === "skip";
  const key = skip ? "" : `${name}\u0000${JSON.stringify(args)}`;
  // Entries are cached by key, so recomputing returns the same one.
  const entry = useMemo(
    () => (skip ? undefined : client.entry(key, name, args)),
    [args, key, name, skip],
  );
  const subscribe = useCallback(
    (onChange: () => void) => (entry ? client.listen(key, entry, onChange) : () => {}),
    [entry, key],
  );
  const state = useSyncExternalStore(subscribe, () => entry?.state);
  return { data: state?.value as T | undefined, error: state?.error };
}

let configPromise: Promise<CommsConfig> | undefined;
let configValue: CommsConfig | undefined;
const configListeners = new Set<() => void>();

const DISABLED: CommsConfig = { enabled: false, testMode: false, postAs: null, homeMachine: null };

function loadConfig(): Promise<CommsConfig> {
  configPromise ??= fetch(url("/config"), { credentials: "include" })
    .then(async (response) => (response.ok ? ((await response.json()) as CommsConfig) : DISABLED))
    .catch(() => DISABLED)
    .then((config) => {
      configValue = config;
      for (const listener of configListeners) listener();
      return config;
    });
  return configPromise;
}

/** This server's comms setup; `undefined` until known. A server without comms reports disabled. */
export function useCommsConfig(): CommsConfig | undefined {
  useEffect(() => {
    void loadConfig();
  }, []);
  return useSyncExternalStore(
    (onChange) => {
      configListeners.add(onChange);
      return () => configListeners.delete(onChange);
    },
    () => configValue,
  );
}
