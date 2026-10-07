// Fork-only (agent comms): the sidebar's Group Chats shelf, above Settled.
// Lists the comms server's group chats (test mode: only test ones), newest
// activity first; a row opens the chat page. Hidden on a server without comms
// or with no group chats. Expanded by default, remembered per browser.
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { UsersIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

import { useCommsConfig, useCommsQuery } from "./commsClient";
import type { ConversationSummary } from "./commsTypes";
import { chatTitle, groupChats } from "./groupChat.logic";
import { readGroupChatSeen, useGroupChatSeenVersion } from "./groupChatSeen";

const EXPANDED_KEY = "t3code:sidebar:group-chats-expanded";

/** The group chats the shelf shows; `undefined` while unknown, empty when hidden. */
function useShelfChats(): ReadonlyArray<ConversationSummary> | undefined {
  const config = useCommsConfig();
  const enabled = config?.enabled === true;
  const { data } = useCommsQuery<{ conversations: ReadonlyArray<ConversationSummary> }>(
    "conversations:list",
    enabled ? {} : "skip",
  );
  return useMemo(() => {
    if (config && !enabled) return [];
    return data ? groupChats(data.conversations, null) : undefined;
  }, [config, data, enabled]);
}

/** Whether the shelf renders; the sidebar uses it to place the bottom shelves. */
export function useGroupChatsShelfVisible(): boolean {
  return (useShelfChats()?.length ?? 0) > 0;
}

export function GroupChatsShelf(props: { readonly className?: string }) {
  const chats = useShelfChats();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const navigate = useNavigate();
  const activeId = useParams({
    strict: false,
    select: (params) => (params as { conversationId?: string }).conversationId ?? null,
  });
  useGroupChatSeenVersion();
  if (!chats || chats.length === 0) return null;
  // The open chat is being read, whichever of its updates arrives first.
  const isUnread = (chat: ConversationSummary) =>
    chat.id !== activeId && chat.lastSeq > readGroupChatSeen(chat.id);
  const unread = chats.filter(isUnread);
  return (
    <li className={cn("list-none", props.className)} data-testid="sidebar-group-chats-shelf">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          onClick={toggle}
          expanded={expanded}
          tone={unread.length > 0 && !expanded ? "accent" : "muted"}
          data-testid="sidebar-group-chats-shelf-toggle"
        >
          {expanded
            ? "Group Chats"
            : `Group Chats (${chats.length}${unread.length ? `, ${unread.length} new` : ""})`}
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul role="presentation" className="flex flex-col gap-px">
          {chats.map((chat) => {
            const unseen = isUnread(chat);
            const active = chat.id === activeId;
            return (
              <li key={chat.id} className="list-none">
                <button
                  type="button"
                  data-testid={`sidebar-group-chat-${chat.id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() =>
                    void navigate({
                      to: "/group-chats/$conversationId",
                      params: { conversationId: chat.id },
                    })
                  }
                  className={cn(
                    "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                    active
                      ? "bg-sidebar-row-active text-sidebar-foreground"
                      : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  )}
                >
                  <UsersIcon aria-hidden className="size-4 shrink-0 opacity-70" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      unseen && "font-semibold text-sidebar-foreground",
                    )}
                  >
                    {chatTitle(chat)}
                  </span>
                  {unseen ? (
                    <span
                      aria-label="new messages"
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                    />
                  ) : (
                    <span className="shrink-0 text-xs text-sidebar-muted-foreground/60">
                      {chat.members.length}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
