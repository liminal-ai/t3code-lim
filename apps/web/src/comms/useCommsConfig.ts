// Fork-only (agent comms): the hooks every comms surface uses. They also report
// the connected environments, so whichever comms surface is on screen (button,
// shelf, page, chat) keeps comms routed to the T3 that serves it.
import type { CommsConfig, EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "~/state/environments";

import { useCommsConfigSnapshot, useCommsRouteSnapshot } from "./commsClient";
import { routeEnvironmentId } from "./commsRoute.logic";
import { useCommsEnvironmentRouting } from "./useCommsEnvironmentRouting";

export function useCommsConfig(): CommsConfig | undefined {
  useCommsEnvironmentRouting();
  return useCommsConfigSnapshot();
}

/**
 * The T3 environment that serves comms: its threads are the ones "This T3"
 * registers (under that server's COMMS_HOME_MACHINE), and Open thread goes there.
 */
export function useCommsEnvironmentId(): EnvironmentId | null {
  const primaryId = usePrimaryEnvironmentId();
  return routeEnvironmentId(useCommsRouteSnapshot(), primaryId) as EnvironmentId | null;
}
