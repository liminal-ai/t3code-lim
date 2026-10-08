// Fork-only (agent comms): tells the comms client which environments are
// connected, so comms can follow the T3 that serves it (commsRoute.logic.ts).
import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { useActiveEnvironmentId } from "~/state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession, readPreparedConnection } from "~/state/session";
import { environmentSummaries } from "~/state/presentation";

import { setCommsEnvironments } from "./commsClient";
import type { CommsEnvironment } from "./commsRoute.logic";

// Changes whenever any connected environment's prepared connection (base URL or bearer) changes.
const preparedConnectionsStampAtom = Atom.make((get) => {
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const stamp = connected.map((id) => {
    const prepared = Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
    return [id, prepared?.httpBaseUrl ?? null, prepared?.httpAuthorization ?? null] as const;
  });
  return JSON.stringify(stamp);
}).pipe(Atom.withLabel("comms:prepared-connections-stamp"));

export function useCommsEnvironmentRouting(): void {
  const connected = useConnectedEnvironmentIds();
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useActiveEnvironmentId();
  // Re-run when any prepared connection for a connected environment changes.
  const preparedStamp = useAtomValue(preparedConnectionsStampAtom);
  useEffect(() => {
    const list: CommsEnvironment[] = [];
    for (const id of connected) {
      if (id === primaryId) continue;
      const prepared = readPreparedConnection(id);
      if (!prepared) continue;
      list.push({
        id,
        httpBaseUrl: prepared.httpBaseUrl,
        authorization: prepared.httpAuthorization,
      });
    }
    setCommsEnvironments({ activeId, list });
  }, [activeId, connected, preparedStamp, primaryId]);
}
