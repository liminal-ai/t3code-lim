// Fork-only (agent comms): tells the comms client which environments are
// connected, so comms can follow the T3 that serves it (commsRoute.logic.ts).
import { useEffect } from "react";

import { useActiveEnvironmentId } from "~/state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { readPreparedConnection } from "~/state/session";

import { setCommsEnvironments } from "./commsClient";
import type { CommsEnvironment } from "./commsRoute.logic";

export function useCommsEnvironmentRouting(): void {
  const connected = useConnectedEnvironmentIds();
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useActiveEnvironmentId();
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
  }, [activeId, connected, primaryId]);
}
