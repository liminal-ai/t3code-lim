// Fork-only (agent comms): which T3 server the comms UI talks to. Comms lives on
// whichever server has COMMS_* set, which isn't always the desktop's own local
// server: the desktop is often connected to a remote T3 (staging, lim-builder).
// Each connected environment is a candidate; the first that serves comms wins.

/** How the client authenticates HTTP to a connected environment (client-runtime's PreparedHttpAuthorization). */
export type EnvironmentHttpAuthorization =
  | { readonly _tag: "Bearer"; readonly token: string }
  | { readonly _tag: "Dpop"; readonly accessToken: string; readonly expiresAtEpochMs: number };

/** A connected, non-primary environment as the routing hook reports it. */
export interface CommsEnvironment {
  readonly id: string;
  readonly httpBaseUrl: string;
  readonly authorization: EnvironmentHttpAuthorization | null;
}

export type CommsRoute =
  | { readonly kind: "primary" }
  | {
      readonly kind: "environment";
      readonly id: string;
      readonly baseUrl: string;
      /** `null` means the session cookie (same-origin only). */
      readonly bearer: string | null;
    };

/**
 * The T3 environment comms acts on (threads for "This T3", Open thread): the
 * route's own, or the primary's. Before any route is chosen that's the primary;
 * once routing has run, no route means none (a remote that just dropped mustn't
 * map its threads onto the primary).
 */
export const routeEnvironmentId = (
  state: { readonly route: CommsRoute | null; readonly chosen: boolean },
  primaryId: string | null,
): string | null =>
  state.route?.kind === "environment"
    ? state.route.id
    : state.route?.kind === "primary" || !state.chosen
      ? primaryId
      : null;

export const routeKey = (route: CommsRoute): string =>
  route.kind === "primary" ? "primary" : `environment:${route.id}`;

/**
 * The route to a connected environment, or `null` when comms can't reach it with
 * a plain fetch: DPoP (relay) needs a fresh proof per request, and a cookie
 * session only works on the page's own origin.
 */
export function environmentRoute(
  environment: CommsEnvironment,
  pageOrigin: string | null,
): CommsRoute | null {
  const auth = environment.authorization;
  if (auth?._tag === "Dpop") return null;
  if (auth === null) {
    let origin: string;
    try {
      origin = new URL(environment.httpBaseUrl).origin;
    } catch {
      return null;
    }
    if (origin !== pageOrigin) return null;
  }
  return {
    kind: "environment",
    id: environment.id,
    baseUrl: environment.httpBaseUrl,
    bearer: auth?._tag === "Bearer" ? auth.token : null,
  };
}

/**
 * Candidates in preference order: the active environment, then the primary, then
 * the rest. A primary reported as disconnected drops out while a remote can take
 * over; with nothing else to try it stays (its connection may still be coming up).
 */
export function orderRoutes(input: {
  readonly hasPrimary: boolean;
  readonly primaryConnected?: boolean | undefined;
  readonly activeId: string | null;
  readonly environments: ReadonlyArray<CommsEnvironment>;
  readonly pageOrigin: string | null;
}): ReadonlyArray<CommsRoute> {
  const remote = input.environments.flatMap((environment) => {
    const route = environmentRoute(environment, input.pageOrigin);
    return route ? [route] : [];
  });
  const active = remote.filter(
    (route) => route.kind === "environment" && route.id === input.activeId,
  );
  const rest = remote.filter((route) => !active.includes(route));
  const primary =
    input.hasPrimary && (input.primaryConnected !== false || remote.length === 0)
      ? [{ kind: "primary" } as const]
      : [];
  return [...active, ...primary, ...rest];
}

export type RouteProbe<C> =
  | { readonly kind: "enabled"; readonly config: C }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed" };

/**
 * Probes candidates in order and takes the first that serves comms. `retry` is
 * set when a more-preferred candidate failed transiently, so a later probe can
 * move back to it once it recovers. `failed` lists the candidates whose probe
 * failed transiently (as opposed to a definite no).
 */
export async function chooseRoute<C>(
  routes: ReadonlyArray<CommsRoute>,
  probe: (route: CommsRoute) => Promise<RouteProbe<C>>,
): Promise<{
  readonly route: CommsRoute | null;
  readonly config: C | null;
  readonly retry: boolean;
  readonly failed: ReadonlyArray<CommsRoute>;
}> {
  const failed: CommsRoute[] = [];
  for (const route of routes) {
    const result = await probe(route);
    if (result.kind === "enabled") {
      return { route, config: result.config, retry: failed.length > 0, failed };
    }
    if (result.kind === "failed") failed.push(route);
  }
  return { route: null, config: null, retry: failed.length > 0, failed };
}
