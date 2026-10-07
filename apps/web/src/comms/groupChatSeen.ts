// Fork-only (agent comms): the highest message seq this browser has shown per
// group chat, so sidebar rows can show unread. The comms server's own read
// position is per participant, and the admin list doesn't report it.
import { useSyncExternalStore } from "react";

import { seenStorageKey } from "./groupChat.logic";

const listeners = new Set<() => void>();
let version = 0;

export function readGroupChatSeen(conversationId: string): number {
  try {
    return Number(window.localStorage.getItem(seenStorageKey(conversationId))) || 0;
  } catch {
    return 0;
  }
}

export function markGroupChatSeen(conversationId: string, seq: number): void {
  if (seq <= readGroupChatSeen(conversationId)) return;
  try {
    window.localStorage.setItem(seenStorageKey(conversationId), String(seq));
  } catch {
    // private mode or quota: unread state lasts for this page only
  }
  version++;
  for (const listener of listeners) listener();
}

/** Re-renders when any chat is marked seen; read values with readGroupChatSeen. */
export function useGroupChatSeenVersion(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => version,
  );
}
