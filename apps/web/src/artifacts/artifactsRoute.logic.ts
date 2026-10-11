// Fork-only (artifacts): which T3 server's store the Artifacts page shows. Each
// environment has its own store (PROPOSAL §2.2), so the page follows one
// environment at a time: the one picked on the page, else the active one, else
// the primary. Reachability is the same as for comms: a plain fetch with a
// bearer, or the session cookie on the page's own origin.
import {
  type CommsRoute,
  type EnvironmentHttpAuthorization,
  environmentRoute,
} from "~/comms/commsRoute.logic";

/** How the page reaches one environment's `/api/artifacts`. */
export type ArtifactsRoute = CommsRoute;

export interface ArtifactsEnvironmentOption {
  readonly id: string;
  readonly label: string;
  readonly route: ArtifactsRoute;
}

/** A connected, non-primary environment and how the client authenticates to it. */
export interface ArtifactsRemoteEnvironment {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly authorization: EnvironmentHttpAuthorization | null;
}

/** The primary first, then every other connected environment a plain fetch can reach. */
export function artifactsEnvironmentOptions(input: {
  readonly primary: { readonly id: string; readonly label: string } | null;
  readonly remotes: ReadonlyArray<ArtifactsRemoteEnvironment>;
  readonly pageOrigin: string | null;
}): ReadonlyArray<ArtifactsEnvironmentOption> {
  const primary: ArtifactsEnvironmentOption[] = input.primary
    ? [{ id: input.primary.id, label: input.primary.label, route: { kind: "primary" } }]
    : [];
  const remotes = input.remotes.flatMap((remote): ArtifactsEnvironmentOption[] => {
    if (remote.id === input.primary?.id) return [];
    const route = environmentRoute(
      { id: remote.id, httpBaseUrl: remote.httpBaseUrl, authorization: remote.authorization },
      input.pageOrigin,
    );
    return route ? [{ id: remote.id, label: remote.label, route }] : [];
  });
  return [...primary, ...remotes];
}

/** The page's pick while it's still an option, else the active environment, else the first. */
export function pickArtifactsEnvironment(
  options: ReadonlyArray<ArtifactsEnvironmentOption>,
  input: { readonly chosenId: string | null; readonly activeId: string | null },
): ArtifactsEnvironmentOption | null {
  return (
    options.find((option) => option.id === input.chosenId) ??
    options.find((option) => option.id === input.activeId) ??
    options[0] ??
    null
  );
}

/**
 * An open artifact belongs to the store it was opened from. When the page's
 * environment changes under it (a remote disconnects and the page falls back,
 * or it reconnects and the page goes back), the selection is cleared rather
 * than read from the other store. Not when the first environment resolves, so
 * a `?id=` link opens.
 */
export const environmentChanged = (shown: string | null, next: string | null): boolean =>
  shown !== null && next !== null && shown !== next;

/** Identifies a route for keying state that belongs to one server. */
export const artifactsRouteKey = (route: ArtifactsRoute): string => JSON.stringify(route);

/** `/home/lee/lim/...` reads as `~/lim/...`; other paths are shown as they are. */
export const displayStorePath = (dir: string): string =>
  dir.replace(/^(?:\/home|\/Users)\/[^/]+(?=\/|$)/, "~");
