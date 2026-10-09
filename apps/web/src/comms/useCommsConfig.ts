// Fork-only (agent comms): the hooks every comms surface uses. They also report
// the connected environments, so whichever comms surface is on screen (button,
// shelf, page, chat) keeps comms routed to the T3 that serves it.
import type { CommsConfig, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";

import { useCommsConfigSnapshot, useCommsRouteSnapshot } from "./commsClient";
import { closesOnRetarget, routeEnvironmentId } from "./commsRoute.logic";
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

/**
 * Closes an open comms dialog when comms moves to another T3: its form (picked
 * members, thread, owner) belongs to the old server. Dialogs mount only while
 * open, so closing also resets them.
 */
export function useCloseOnCommsRetarget(
  open: boolean,
  onOpenChange: (open: boolean) => void,
): void {
  const key = useCommsRouteKey();
  const openedOn = useRef(key);
  useEffect(() => {
    if (closesOnRetarget(open, openedOn.current, key)) onOpenChange(false);
    else if (!open) openedOn.current = key;
  }, [key, onOpenChange, open]);
}

/** Identifies the comms server in use (changes on failover), for keying server-scoped state. */
export function useCommsRouteKey(): string {
  return JSON.stringify(useCommsRouteSnapshot().route);
}
