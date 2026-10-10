// Fork-only (agent comms): archiving group chats. Archived groups drop out of
// conversations:list (and so the sidebar shelf) unless `includeArchived` is
// set; agents can still post in them, and they still open by id.
import { commsCall, useCommsQuery } from "./commsClient";
import type { ConversationSummary } from "./commsTypes";
import { archiveBatches } from "./groupChat.logic";

/** Archive or unarchive group chats as the post-as person, in batches the server accepts. */
export async function setGroupChatsArchived(
  as: string,
  conversationIds: Iterable<string>,
  archived: boolean,
): Promise<void> {
  const name = archived
    ? "conversations:archiveConversation"
    : "conversations:unarchiveConversation";
  for (const batch of archiveBatches(conversationIds)) {
    await commsCall(name, { as, conversationIds: batch });
  }
}

/** Every conversation, archived ones included; `skip` watches nothing. */
export function useAllConversations(enabled: boolean): {
  readonly data: ReadonlyArray<ConversationSummary> | undefined;
  readonly error: Error | undefined;
} {
  const { data, error } = useCommsQuery<{ conversations: ReadonlyArray<ConversationSummary> }>(
    "conversations:list",
    enabled ? { includeArchived: true } : "skip",
  );
  return { data: data?.conversations, error };
}
