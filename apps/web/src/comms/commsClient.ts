// Fork-only (agent comms): the page's client for /api/comms/* on this T3
// server. Calls are one POST each; every live query rides one streaming POST
// (/api/comms/watch, NDJSON frames), reopened whenever the watched set
// changes. The T3 session cookie is the credential; the server adds the comms
// admin token. Ported from agent-comms' web view (apps/web/src/lib/backend.tsx).
import {
  type CommsArgs,
  CommsCallResponse,
  CommsConfig,
  type CommsMutationName,
  type CommsQueryName,
  CommsWatchFrame,
  type CommsWireError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { isSameOriginBrowserPrimary } from "~/environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "~/environments/primary/target";

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

/**
 * Comms always goes through the primary (local) environment's server, with the
 * same credentials the environment HTTP transport uses (environments/primary/
 * httpLayer.ts): the session cookie for a same-origin browser, the desktop
 * bearer otherwise. Without a primary environment (desktop with its local server
 * disabled) there is no comms.
 */
export const hasCommsServer = (): boolean => readPrimaryEnvironmentTarget() !== null;

async function commsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const target = resolvePrimaryEnvironmentHttpUrl(`/api/comms${path}`);
  const headers = new Headers(init.headers);
  if (isSameOriginBrowserPrimary()) {
    return fetch(target, { ...init, headers, credentials: "include" });
  }
  const bearer = await readDesktopPrimaryBearerToken();
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return fetch(target, { ...init, headers, credentials: "omit" });
}

const decodeCallResponse = Schema.decodeUnknownOption(CommsCallResponse);
const decodeWatchFrame = Schema.decodeUnknownOption(CommsWatchFrame);
const decodeConfig = Schema.decodeUnknownOption(CommsConfig);

const wireError = (error: CommsWireError, status: number) =>
  new CommsError(error.message, status, error.data);

async function readError(response: Response): Promise<CommsError> {
  const body = decodeCallResponse(await response.json().catch(() => null));
  return body._tag === "Some" && "error" in body.value
    ? wireError(body.value.error, response.status)
    : new CommsError(`comms request failed (${response.status})`, response.status);
}

class CommsClient {
  private readonly entries = new Map<string, Entry>();
  private stream: AbortController | undefined;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff = 250;

  async call(kind: "query" | "mutation", name: string, args: Args = {}): Promise<unknown> {
    const response = await commsFetch("/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, args }),
    });
    if (!response.ok) throw await readError(response);
    const body = decodeCallResponse(await response.json());
    if (body._tag === "None") throw new CommsError("comms answered in an unknown shape", 502);
    if ("error" in body.value) throw wireError(body.value.error, response.status);
    return body.value.value;
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
      const response = await commsFetch("/watch", {
        method: "POST",
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
          const frame = line ? decodeWatchFrame(JSON.parse(line)) : undefined;
          if (frame?._tag === "Some") this.deliver(frame.value);
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

  private deliver(frame: CommsWatchFrame): void {
    if (!("id" in frame)) return; // heartbeat
    const entry = this.entries.get(frame.id);
    if (!entry) return;
    this.set(
      entry,
      "error" in frame ? { error: wireError(frame.error, 400) } : { value: frame.value },
    );
  }

  private set(entry: Entry, state: EntryState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }
}

const client = new CommsClient();

export const commsCall = (name: CommsMutationName, args?: CommsArgs) =>
  client.call("mutation", name, args);

/** A live comms query. `undefined` while loading; `skip` watches nothing. */
export function useCommsQuery<T>(
  name: CommsQueryName,
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
let configRetry: ReturnType<typeof setTimeout> | undefined;
let configBackoff = 2_000;
const configListeners = new Set<() => void>();

const DISABLED: CommsConfig = { enabled: false, testMode: false, postAs: null, homeMachine: null };

function publishConfig(config: CommsConfig): void {
  configValue = config;
  for (const listener of configListeners) listener();
}

/**
 * Only a 404 (comms not configured on this server) or no primary environment
 * means disabled. Anything else (auth not ready, network, a restarting server)
 * is retried with backoff, so a transient failure doesn't hide comms for the session.
 */
function loadConfig(): Promise<CommsConfig> {
  if (configPromise) return configPromise;
  if (!hasCommsServer()) {
    publishConfig(DISABLED);
    configPromise = Promise.resolve(DISABLED);
    return configPromise;
  }
  configPromise = commsFetch("/config")
    .then(async (response) => {
      if (response.ok) {
        const config = decodeConfig(await response.json());
        if (config._tag === "Some") return config.value;
        throw new CommsError("comms config in an unknown shape", 502);
      }
      if (response.status === 404) return DISABLED;
      throw new CommsError(`comms config failed (${response.status})`, response.status);
    })
    .then((config) => {
      configBackoff = 2_000;
      publishConfig(config);
      return config;
    })
    .catch(() => {
      configPromise = undefined;
      clearTimeout(configRetry);
      configRetry = setTimeout(() => void loadConfig(), configBackoff);
      configBackoff = Math.min(configBackoff * 2, 60_000);
      return configValue ?? DISABLED;
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
