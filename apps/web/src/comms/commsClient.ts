// Fork-only (agent comms): the page's client for /api/comms/* on the T3
// server that serves comms (commsRoute.logic.ts picks it). Calls are one POST each; every live query rides one streaming POST
// (/api/comms/watch, NDJSON frames), reopened whenever the watched set
// changes. The T3 session cookie or the environment's bearer is the
// credential; the server adds the comms admin token. Ported from agent-comms' web view (apps/web/src/lib/backend.tsx).
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

import {
  type CommsEnvironment,
  type CommsRoute,
  chooseRoute,
  orderRoutes,
  type RouteProbe,
} from "./commsRoute.logic";

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

/** Connected non-primary environments and the active one; set by useCommsEnvironmentRouting. */
let environments: {
  readonly activeId: string | null;
  readonly list: ReadonlyArray<CommsEnvironment>;
  /** A disconnected primary gives way to a connected remote (orderRoutes). */
  readonly primaryConnected?: boolean;
} = {
  activeId: null,
  list: [],
};
let route: CommsRoute | null = null;

const pageOrigin = (): string | null =>
  typeof window === "undefined" ? null : (window.location?.origin ?? null);

const candidateRoutes = (): ReadonlyArray<CommsRoute> =>
  orderRoutes({
    hasPrimary: readPrimaryEnvironmentTarget() !== null,
    primaryConnected: environments.primaryConnected,
    activeId: environments.activeId,
    environments: environments.list,
    pageOrigin: pageOrigin(),
  });

/** Whether any connected T3 could serve comms (the primary, or a remote reachable by plain fetch). */
export const hasCommsServer = (): boolean => candidateRoutes().length > 0;

/**
 * The primary goes through the same credentials as the environment HTTP transport
 * (environments/primary/httpLayer.ts): the session cookie for a same-origin
 * browser, the desktop bearer otherwise. Another environment uses its own base
 * URL and the bearer from its prepared connection.
 */
async function fetchVia(via: CommsRoute, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (via.kind === "environment") {
    const target = new URL(`/api/comms${path}`, via.baseUrl).toString();
    if (via.bearer === null) return fetch(target, { ...init, headers, credentials: "include" });
    headers.set("authorization", `Bearer ${via.bearer}`);
    return fetch(target, { ...init, headers, credentials: "omit" });
  }
  const target = resolvePrimaryEnvironmentHttpUrl(`/api/comms${path}`);
  if (isSameOriginBrowserPrimary()) {
    return fetch(target, { ...init, headers, credentials: "include" });
  }
  const bearer = await readDesktopPrimaryBearerToken();
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return fetch(target, { ...init, headers, credentials: "omit" });
}

/** Set once a probe has finished: after that, no route means no T3 serves comms. */
let chosenOnce = false;
/** The route as components see it (a new object per change, for useSyncExternalStore). */
let routeState: { readonly route: CommsRoute | null; readonly chosen: boolean } = {
  route: null,
  chosen: false,
};

/** Calls go to the chosen route; before any probe has finished, to the first candidate. */
async function commsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const via = route ?? (chosenOnce ? undefined : candidateRoutes()[0]);
  if (!via) throw new CommsError("no connected T3 serves comms", 503);
  return fetchVia(via, path, init);
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

  /** Bumped on every retarget; a call that straddles one is stale. */
  private generation = 0;

  async call(kind: "query" | "mutation", name: string, args: Args = {}): Promise<unknown> {
    const generation = this.generation;
    const response = await commsFetch("/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, args }),
    });
    if (!response.ok) throw await readError(response);
    const body = decodeCallResponse(await response.json());
    if (body._tag === "None") throw new CommsError("comms answered in an unknown shape", 502);
    if ("error" in body.value) throw wireError(body.value.error, response.status);
    // Comms moved to another T3 meanwhile: the answer is about the old server, so the
    // caller mustn't act on it (navigate to its new chat, clear a draft as sent).
    if (generation !== this.generation) {
      throw new CommsError("comms moved to another T3; check the result there", 409);
    }
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
          // A frame from a stream that was replaced (retarget, new watched set) is stale.
          if (frame?._tag === "Some" && this.stream === controller) this.deliver(frame.value);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // Configuration and auth refusals won't heal on retry: show them, and check
      // whether comms now lives on another connected T3.
      if (error instanceof CommsError && error.status !== 502 && error.status < 500) {
        for (const [, entry] of live) this.set(entry, { error });
        reprobe();
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

  /** Comms moved to another server: drop what the old one said and re-watch on the new one. */
  retarget(): void {
    this.generation += 1;
    this.stream?.abort();
    this.stream = undefined;
    for (const entry of this.entries.values()) this.set(entry, undefined);
    this.reopen();
  }

  private set(entry: Entry, state: EntryState | undefined): void {
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

/** A probe that hasn't answered by then counts as a transient failure, so later candidates still get probed. */
const PROBE_TIMEOUT_MS = 8_000;

/** One candidate's `/config`: a 404 or `enabled: false` is a definite no; anything else may heal. */
async function probe(via: CommsRoute): Promise<RouteProbe<CommsConfig>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchVia(via, "/config", { signal: controller.signal });
    if (response.status === 404) return { kind: "disabled" };
    if (!response.ok) return { kind: "failed" };
    const config = decodeConfig(await response.json());
    if (config._tag === "None") return { kind: "failed" };
    return config.value.enabled ? { kind: "enabled", config: config.value } : { kind: "disabled" };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Same environment with a new endpoint or bearer counts as a different route. */
const sameRoute = (a: CommsRoute | null, b: CommsRoute | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function applyRoute(next: CommsRoute | null): void {
  const firstChoice = !chosenOnce;
  chosenOnce = true;
  const changed = !sameRoute(route, next);
  route = next;
  if (changed) client.retarget();
  if (changed || firstChoice) {
    routeState = { route, chosen: true };
    for (const listener of configListeners) listener();
  }
}

/**
 * Picks the T3 that serves comms. Only definite answers (404, or not enabled)
 * from every candidate mean disabled. A transient failure (auth not ready,
 * network, a restarting server) is retried with backoff, so it doesn't hide
 * comms for the session; and while a more-preferred candidate is failing, a
 * retry can move back to it once it recovers.
 */
function loadConfig(): Promise<CommsConfig> {
  if (configPromise) return configPromise;
  const routes = candidateRoutes();
  if (routes.length === 0) {
    applyRoute(null);
    publishConfig(DISABLED);
    configPromise = Promise.resolve(DISABLED);
    return configPromise;
  }
  const attempt = (configPromise = chooseRoute(routes, probe).then((chosen) => {
    if (configPromise !== attempt) return configValue ?? DISABLED; // superseded by a newer probe
    if (chosen.route === null && chosen.retry) {
      scheduleRetry();
      // Keep the current route only if its own probe failed transiently; a route that's
      // gone, or that just said 404 / not enabled, is dropped.
      if (chosen.failed.some((candidate) => sameRoute(candidate, route))) {
        return configValue ?? DISABLED;
      }
      applyRoute(null);
      publishConfig(DISABLED);
      return DISABLED;
    }
    if (chosen.retry) scheduleRetry();
    else configBackoff = 2_000;
    applyRoute(chosen.route);
    const config = chosen.config ?? DISABLED;
    publishConfig(config);
    return config;
  }));
  return attempt;
}

function scheduleRetry(): void {
  configPromise = undefined;
  clearTimeout(configRetry);
  configRetry = setTimeout(() => void loadConfig(), configBackoff);
  configBackoff = Math.min(configBackoff * 2, 60_000);
}

const environmentsKey = (value: typeof environments): string =>
  JSON.stringify([
    value.activeId,
    value.primaryConnected ?? null,
    value.list.map((e) => [e.id, e.httpBaseUrl, e.authorization]),
  ]);

/**
 * The connected environments changed (one connected or dropped, or the active
 * one switched): choose the comms server again.
 */
/** Choose the comms server again (the current one refused a watch). */
function reprobe(): void {
  configPromise = undefined;
  clearTimeout(configRetry);
  void loadConfig();
}

export function setCommsEnvironments(next: typeof environments): void {
  if (environmentsKey(next) === environmentsKey(environments)) return;
  environments = next;
  // A route that's no longer a candidate stops now, not when the reprobe (possibly
  // slow) finishes: calls are refused until a new route is chosen.
  if (route !== null && !candidateRoutes().some((candidate) => sameRoute(candidate, route))) {
    applyRoute(null);
  }
  configPromise = undefined;
  clearTimeout(configRetry);
  configBackoff = 2_000;
  void loadConfig();
}

/**
 * The comms server's setup; `undefined` until known, disabled when no connected
 * T3 serves comms. Components use `useCommsConfig` (useCommsConfig.ts), which
 * also keeps the connected environments current.
 */
/** The chosen route, and whether routing has chosen yet (`route: null, chosen: true` = no T3 serves comms). */
export function useCommsRouteSnapshot(): {
  readonly route: CommsRoute | null;
  readonly chosen: boolean;
} {
  return useSyncExternalStore(
    (onChange) => {
      configListeners.add(onChange);
      return () => configListeners.delete(onChange);
    },
    () => routeState,
  );
}

export function useCommsConfigSnapshot(): CommsConfig | undefined {
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
