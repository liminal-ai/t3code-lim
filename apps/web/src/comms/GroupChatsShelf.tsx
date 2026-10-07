// Fork-only (agent comms): the sidebar's Group Chats shelf, above Settled.
// Lists the comms server's group chats (test mode: only test ones), newest
// activity first; a row opens the chat page. Hidden on a server without comms
// or with no group chats. Expanded by default, remembered per browser.
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

import { CreateGroupDialog } from "./CommsDialogs";
import { useCommsConfig, useCommsQuery } from "./commsClient";
import type { ConversationSummary, ConversationView } from "./commsTypes";
import { chatTitle, groupChats, memberActivity } from "./groupChat.logic";
import { readGroupChatSeen, useGroupChatSeenVersion } from "./groupChatSeen";

const EXPANDED_KEY = "t3code:sidebar:group-chats-expanded";
/** Rows that watch their chat's latest deliveries (Kit, 2026-10-07: never more than 20). */
const ACTIVITY_WATCH_LIMIT = 20;
/** Chats shown before "Show more": prod has dozens of old validation groups. */
const SHELF_INITIAL_COUNT = 8;
const SHELF_PAGE_COUNT = 20;

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
  return useCommsConfig()?.enabled === true;
}

function activityLabel(names: ReadonlyArray<string>, verb: string): string {
  return names.length === 1 ? `@${names[0]} ${verb}` : `${names.length} ${verb}`;
}

function GroupChatRow(props: {
  readonly chat: ConversationSummary;
  readonly active: boolean;
  readonly unseen: boolean;
  readonly watch: boolean;
  readonly onOpen: () => void;
}) {
  const { chat } = props;
  const { data: view } = useCommsQuery<ConversationView>(
    "conversations:view",
    props.watch ? { conversationId: chat.id, limit: 5 } : "skip",
  );
  const activity = useMemo(() => memberActivity(view?.messages ?? []), [view]);
  const working = [...activity].filter(([, a]) => a === "working").map(([name]) => name);
  const failed = [...activity].filter(([, a]) => a === "failed").map(([name]) => name);
  return (
    <li className="list-none">
      <button
        type="button"
        data-testid={`sidebar-group-chat-${chat.id}`}
        aria-current={props.active ? "page" : undefined}
        onClick={props.onOpen}
        className={cn(
          "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          props.active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <UsersIcon aria-hidden className="size-4 shrink-0 opacity-70" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", props.unseen && "font-semibold text-sidebar-foreground")}>
            {chatTitle(chat)}
          </span>
          {working.length || failed.length ? (
            <span className="truncate text-xs">
              {working.length ? (
                <span className="text-info">{activityLabel(working, "working")}</span>
              ) : null}
              {working.length && failed.length ? " · " : null}
              {failed.length ? (
                <span className="text-destructive">{activityLabel(failed, "failed")}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        {working.length ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-info"
          />
        ) : props.unseen ? (
          <span aria-label="new messages" className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : (
          <span className="shrink-0 text-xs text-sidebar-muted-foreground/60">
            {chat.members.length}
          </span>
        )}
      </button>
    </li>
  );
}

export function GroupChatsShelf(props: { readonly className?: string }) {
  const config = useCommsConfig();
  const chats = useShelfChats();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const [creating, setCreating] = useState(false);
  const [visibleCount, setVisibleCount] = useState(SHELF_INITIAL_COUNT);
  const navigate = useNavigate();
  const activeId = useParams({
    strict: false,
    select: (params) => (params as { conversationId?: string }).conversationId ?? null,
  });
  useGroupChatSeenVersion();
  if (!config?.enabled || !chats) return null;
  // The open chat is being read, whichever of its updates arrives first.
  const isUnread = (chat: ConversationSummary) =>
    chat.id !== activeId && chat.lastSeq > readGroupChatSeen(chat.id);
  const unread = chats.filter(isUnread);
  // Newest activity first; the open chat stays listed even past the cut.
  const shown = chats.filter((chat, index) => index < visibleCount || chat.id === activeId);
  const hiddenCount = chats.length - shown.length;
  return (
    <li className={cn("list-none", props.className)} data-testid="sidebar-group-chats-shelf">
      <div className="mx-0.5 flex h-8 items-center gap-0.5">
        <div className="min-w-0 flex-1">
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
        <button
          type="button"
          aria-label="New group chat"
          data-testid="sidebar-group-chats-new"
          onClick={() => setCreating(true)}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        chats.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-sidebar-muted-foreground/60">No group chats yet</p>
        ) : (
          <ul role="presentation" className="flex flex-col gap-px">
            {shown.map((chat, index) => (
              <GroupChatRow
                key={chat.id}
                chat={chat}
                active={chat.id === activeId}
                unseen={isUnread(chat)}
                watch={index < ACTIVITY_WATCH_LIMIT}
                onOpen={() =>
                  void navigate({
                    to: "/group-chats/$conversationId",
                    params: { conversationId: chat.id },
                  })
                }
              />
            ))}
            {hiddenCount > 0 ? (
              <li className="list-none">
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + SHELF_PAGE_COUNT)}
                  className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  Show {Math.min(hiddenCount, SHELF_PAGE_COUNT)} more
                </button>
              </li>
            ) : null}
          </ul>
        )
      ) : null}
      <CreateGroupDialog open={creating} onOpenChange={setCreating} />
    </li>
  );
}
