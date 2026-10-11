// Fork-only (artifacts): the Artifacts page's data. Which environment's store it
// shows (artifactsRoute.logic.ts), that store's artifact list, and one change
// stream per store that keeps the list and the open artifact current.
import { useAtomValue } from "@effect/atom-react";
import type { LimArtifactListResponse } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { readPrimaryEnvironmentTarget } from "~/environments/primary/target";
import { useActiveEnvironmentId } from "~/state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentSession } from "~/state/session";

import { listArtifacts, openArtifactsWatch } from "./artifactsClient";
import {
  type ArtifactsEnvironmentOption,
  type ArtifactsRemoteEnvironment,
  type ArtifactsRoute,
  artifactsEnvironmentOptions,
  artifactsRouteKey,
  pickArtifactsEnvironment,
} from "./artifactsRoute.logic";
import {
  type ArtifactWatchEvent,
  type ArtifactWatchStatus,
  coalesce,
  watchArtifacts,
} from "./artifactsWatch.logic";

/** Effects key on the route's JSON, so they don't restart when an equal route is rebuilt. */
const routeFromKey = (key: string | null): ArtifactsRoute | null =>
  key === null ? null : (JSON.parse(key) as ArtifactsRoute);

const pageOrigin = (): string | null =>
  typeof window === "undefined" ? null : (window.location?.origin ?? null);

/** The environments whose store the page can show, and the one it shows. */
export function useArtifactsEnvironment(): {
  readonly options: ReadonlyArray<ArtifactsEnvironmentOption>;
  readonly selected: ArtifactsEnvironmentOption | null;
  readonly choose: (id: string) => void;
} {
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useActiveEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const { presentationById } = useEnvironments();
  const [chosenId, choose] = useState<string | null>(null);
  // Subscribed, so a prepared connection that resolves after its environment
  // connected is picked up (as in useCommsEnvironmentRouting).
  const preparedAtom = useMemo(
    () =>
      Atom.make((get) =>
        connected
          .filter((id) => id !== primaryId)
          .flatMap((id) => {
            const prepared = Option.getOrNull(
              get(environmentSession.preparedConnectionValueAtom(id)),
            );
            return prepared
              ? [
                  {
                    id: id as string,
                    httpBaseUrl: prepared.httpBaseUrl,
                    authorization: prepared.httpAuthorization,
                  },
                ]
              : [];
          }),
      ),
    [connected, primaryId],
  );
  const prepared = useAtomValue(preparedAtom);
  const options = useMemo(() => {
    const label = (id: string) =>
      presentationById.get(id as never)?.entry.target.label ?? "Environment";
    const remotes = prepared.map((remote): ArtifactsRemoteEnvironment => ({
      ...remote,
      label: label(remote.id),
    }));
    const hasPrimary = readPrimaryEnvironmentTarget() !== null;
    return artifactsEnvironmentOptions({
      primary: hasPrimary && primaryId !== null ? { id: primaryId, label: label(primaryId) } : null,
      remotes,
      pageOrigin: pageOrigin(),
    });
  }, [prepared, presentationById, primaryId]);
  const selected = pickArtifactsEnvironment(options, { chosenId, activeId });
  return { options, selected, choose };
}

interface ArtifactListState {
  readonly key: string | null;
  readonly data?: LimArtifactListResponse;
  readonly error?: Error;
}

/**
 * Reads of the list for the store `key` names, coalesced. Answers that land
 * while it's stopped (the page moved to another store) are dropped.
 */
function listLoader(
  key: string,
  setState: (update: (current: ArtifactListState) => ArtifactListState) => void,
): { readonly refetch: () => void; readonly start: () => () => void } {
  let active = false;
  const refetch = coalesce(async () => {
    let next: ArtifactListState;
    try {
      next = { key, data: await listArtifacts(routeFromKey(key)!) };
    } catch (error) {
      next = { key, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!active) return;
    // A failed re-read keeps showing the last list, with the error beside it.
    setState((current) =>
      next.error && current.key === key ? { ...current, error: next.error } : next,
    );
  });
  return {
    refetch,
    // Restartable: StrictMode stops and starts the same loader once on mount.
    start: () => {
      active = true;
      refetch();
      return () => {
        active = false;
      };
    },
  };
}

/** A route's artifact list; `refetch` coalesces bursts of calls into at most one more read. */
export function useArtifactList(route: ArtifactsRoute | null): {
  readonly data: LimArtifactListResponse | undefined;
  readonly error: Error | undefined;
  readonly refetch: () => void;
} {
  const key = route ? artifactsRouteKey(route) : null;
  const [state, setState] = useState<ArtifactListState>({ key: null });
  const loader = useMemo(() => (key === null ? null : listLoader(key, setState)), [key]);
  useEffect(() => {
    if (!loader) return;
    return loader.start();
  }, [loader]);
  const refetch = loader?.refetch ?? noop;
  return state.key === key
    ? { data: state.data, error: state.error, refetch }
    : { data: undefined, error: undefined, refetch };
}

const noop = () => {};

export interface ArtifactWatchHub {
  readonly subscribe: (listener: (event: ArtifactWatchEvent) => void) => () => void;
  readonly emit: (event: ArtifactWatchEvent) => void;
}

const createHub = (): ArtifactWatchHub => {
  const listeners = new Set<(event: ArtifactWatchEvent) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
};

/** One change stream for the route's whole store, shared by the list and the open artifact. */
export function useArtifactsWatch(route: ArtifactsRoute | null): {
  readonly hub: ArtifactWatchHub;
  readonly status: ArtifactWatchStatus;
  readonly error: Error | undefined;
} {
  const key = route ? artifactsRouteKey(route) : null;
  // The old store's stream stops before the new one starts, so one hub serves both.
  const [hub] = useState(createHub);
  const [status, setStatus] = useState<{
    readonly status: ArtifactWatchStatus;
    readonly error?: Error;
  }>({ status: "connecting" });
  useEffect(() => {
    const stable = routeFromKey(key);
    if (stable === null) return;
    return watchArtifacts({
      open: (signal) => openArtifactsWatch(stable, signal),
      onEvent: hub.emit,
      onStatus: (next, error) => setStatus(error ? { status: next, error } : { status: next }),
    });
  }, [hub, key]);
  return { hub, status: status.status, error: status.error };
}
