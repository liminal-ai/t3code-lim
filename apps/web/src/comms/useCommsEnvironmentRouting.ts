// Fork-only (agent comms): tells the comms client which environments are
// connected, so comms can follow the T3 that serves it (commsRoute.logic.ts).
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { useActiveEnvironmentId } from "~/state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession } from "~/state/session";

import { setCommsEnvironments } from "./commsClient";
import type { CommsEnvironment } from "./commsRoute.logic";

export function useCommsEnvironmentRouting(): void {
  const connected = useConnectedEnvironmentIds();
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useActiveEnvironmentId();
  // Subscribed, so a prepared connection that resolves (or changes) after its
  // environment connected is picked up.
  const preparedAtom = useMemo(
    () =>
      Atom.make((get) =>
        connected
          .filter((id) => id !== primaryId)
          .flatMap((id): CommsEnvironment[] => {
            const prepared = Option.getOrNull(
              get(environmentSession.preparedConnectionValueAtom(id)),
            );
            return prepared
              ? [
                  {
                    id,
                    httpBaseUrl: prepared.httpBaseUrl,
                    authorization: prepared.httpAuthorization,
                  },
                ]
              : [];
          }),
      ),
    [connected, primaryId],
  );
  const list = useAtomValue(preparedAtom);
  const primaryConnected = primaryId !== null && connected.includes(primaryId);
  useEffect(() => {
    setCommsEnvironments({ activeId, list, primaryConnected });
  }, [activeId, list, primaryConnected]);
}
