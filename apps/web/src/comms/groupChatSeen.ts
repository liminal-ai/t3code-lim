// Fork-only (agent comms): the highest message seq this browser has shown per
// group chat, so sidebar rows can show unread. The comms server's own read
// position is per participant, and the admin list doesn't report it.
import { useSyncExternalStore } from "react";

import { seenStorageKey } from "./groupChat.logic";

const listeners = new Set<() => void>();
let version = 0;
// What this page has seen, so unread clears even when storage refuses writes.
const seenInPage = new Map<string, number>();

export function readGroupChatSeen(conversationId: string): number {
  let stored = 0;
  try {
    stored = Number(window.localStorage.getItem(seenStorageKey(conversationId))) || 0;
  } catch {
    // storage unavailable: the page's own record below
  }
  return Math.max(stored, seenInPage.get(conversationId) ?? 0);
}

export function markGroupChatSeen(conversationId: string, seq: number): void {
  if (seq <= readGroupChatSeen(conversationId)) return;
  seenInPage.set(conversationId, seq);
  try {
    window.localStorage.setItem(seenStorageKey(conversationId), String(seq));
  } catch {
    // private mode or quota: the page's record keeps it until reload
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
