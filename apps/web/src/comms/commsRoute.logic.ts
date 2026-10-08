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

/** Candidates in preference order: the active environment, then the primary, then the rest. */
export function orderRoutes(input: {
  readonly hasPrimary: boolean;
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
  return [...active, ...(input.hasPrimary ? [{ kind: "primary" } as const] : []), ...rest];
}

export type RouteProbe<C> =
  | { readonly kind: "enabled"; readonly config: C }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed" };

/**
 * Probes candidates in order and takes the first that serves comms. `retry` is
 * set when a more-preferred candidate failed transiently, so a later probe can
 * move back to it once it recovers.
 */
export async function chooseRoute<C>(
  routes: ReadonlyArray<CommsRoute>,
  probe: (route: CommsRoute) => Promise<RouteProbe<C>>,
): Promise<{
  readonly route: CommsRoute | null;
  readonly config: C | null;
  readonly retry: boolean;
}> {
  let retry = false;
  for (const route of routes) {
    const result = await probe(route);
    if (result.kind === "enabled") return { route, config: result.config, retry };
    if (result.kind === "failed") retry = true;
  }
  return { route: null, config: null, retry };
}
