// Fork-only (agent comms): one group chat, live from the comms server through
// this T3 server's /api/comms proxy. Based on the old Roundtable page.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { ManageMembersDialog } from "~/comms/CommsDialogs";
import { commsCall, useCommsConfig, useCommsQuery } from "~/comms/commsClient";
import type { ConversationView } from "~/comms/commsTypes";
import {
  GroupChatComposer,
  GroupChatMemberStrip,
  GroupChatTranscript,
} from "~/comms/GroupChatView";
import {
  chatTitle,
  memberActivity,
  parseRecipients,
  recipientsStorageKey,
  wakeableMembers,
} from "~/comms/groupChat.logic";
import { markGroupChatSeen } from "~/comms/groupChatSeen";
import { APP_BASE_NAME } from "~/branding";
import { isElectron } from "~/env";

const VIEW_LIMIT = 200;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Switching chats keeps this route mounted, so the page is keyed by chat: the
 * draft, checked recipients, scroll position and dialogs never carry over (a
 * half-typed draft must not go to, and wake, another group).
 */
function GroupChatRouteView() {
  const { conversationId } = Route.useParams();
  return <GroupChatPage key={conversationId} conversationId={conversationId} />;
}

function GroupChatPage(props: { readonly conversationId: string }) {
  const { conversationId } = props;
  const config = useCommsConfig();
  const [managing, setManaging] = useState(false);
  const self = config?.postAs ?? null;
  const { data: view, error } = useCommsQuery<ConversationView>("conversations:view", {
    conversationId,
    limit: VIEW_LIMIT,
  });
  const members = useMemo(() => view?.members ?? [], [view]);
  const candidates = useMemo(() => wakeableMembers(members, self), [members, self]);
  const messages = useMemo(() => view?.messages ?? [], [view]);
  const activity = useMemo(() => memberActivity(messages), [messages]);
  const working = useMemo(
    () => candidates.filter((m) => activity.get(m.name) === "working").map((m) => m.name),
    [activity, candidates],
  );

  // Checked recipients persist per chat per browser; names no longer in the chat drop at parse time.
  const storageKey = recipientsStorageKey(conversationId);
  const [stored, setStored] = useState(() => ({ key: storageKey, raw: readStored(storageKey) }));
  const raw = stored.key === storageKey ? stored.raw : readStored(storageKey);
  const checked = useMemo(() => parseRecipients(raw, candidates), [raw, candidates]);
  const onCheckedChange = useCallback(
    (name: string, value: boolean) => {
      const next = new Set(checked);
      if (value) next.add(name);
      else next.delete(name);
      const serialized = JSON.stringify([...next]);
      try {
        window.localStorage.setItem(storageKey, serialized);
      } catch {
        // private mode or quota: the choice lives for this page only
      }
      setStored({ key: storageKey, raw: serialized });
    },
    [checked, storageKey],
  );

  const onSend = useCallback(
    (text: string, to: ReadonlyArray<string>) => {
      if (!self) return Promise.reject(new Error("This server has no post-as person configured"));
      return commsCall("conversations:postAs", { as: self, conversationId, to, text });
    },
    [conversationId, self],
  );

  const title = view ? chatTitle(view.conversation) : "Group chat";
  // The app title (DocumentTitleSync) comes back when the page closes.
  useEffect(() => {
    const appTitle = document.title;
    document.title = `${title} · ${APP_BASE_NAME}`;
    return () => {
      document.title = appTitle;
    };
  }, [title]);

  // Shown messages count as seen: the sidebar row's unread dot clears, and the
  // poster's comms inbox items for this chat are marked read.
  // Only a new message counts: delivery-state updates re-send the view without one.
  const lastSeq = view?.conversation.lastSeq ?? 0;
  useEffect(() => {
    if (lastSeq === 0) return;
    markGroupChatSeen(conversationId, lastSeq);
    if (self) {
      void commsCall("inbox:markRead", { human: self, conversationId }).catch(() => undefined);
    }
  }, [conversationId, lastSeq, self]);

  // Follow new messages while the reader sits at the bottom; leave them alone otherwise.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const rowCount = messages.length + working.length;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || rowCount === 0) return;
    const pin = () => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [rowCount]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <div className="flex min-w-0 flex-1 items-baseline gap-3 truncate">
            <h1 className="truncate text-sm font-medium">{title}</h1>
            {members.length ? <GroupChatMemberStrip members={members} activity={activity} /> : null}
            {config?.testMode ? (
              <span className="rounded-full border border-warning/60 px-1.5 text-3xs text-warning">
                test mode
              </span>
            ) : null}
          </div>
          <Button size="compact" variant="ghost" onClick={() => setManaging(true)}>
            Members
          </Button>
        </WorkspacePageHeader>
        {managing ? (
          <ManageMembersDialog conversationId={conversationId} open onOpenChange={setManaging} />
        ) : null}
        <div
          ref={scrollRef}
          className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          }}
        >
          {error && !view ? (
            <div className="px-6 py-12 text-center text-sm text-destructive">{error.message}</div>
          ) : !view ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
            </div>
          ) : messages.length === 0 && working.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-secondary-label">
              No messages yet. Check who to wake below, or @mention them.
            </div>
          ) : (
            <GroupChatTranscript
              messages={messages}
              self={self}
              working={working}
              renderMarkdown={(text) => <ChatMarkdown text={text} cwd={undefined} />}
            />
          )}
        </div>
        {error && view ? (
          <div className="px-6 py-1 text-xs text-destructive">{error.message}</div>
        ) : null}
        <GroupChatComposer
          candidates={candidates}
          onSend={onSend}
          disabled={!view || !self}
          disabledReason={self ? undefined : "Read only: this server has no post-as person"}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/group-chats/$conversationId")({
  component: GroupChatRouteView,
});
