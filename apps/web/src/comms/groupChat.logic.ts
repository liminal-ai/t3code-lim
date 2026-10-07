// Fork-only (agent comms): pure logic for group chats. The comms server wakes
// only the recipients a post names (`to`), so the page decides them: every
// checked member, plus anyone @mentioned in the text; @all / @everyone wake
// every agent member. Ported from the old Roundtable view (lhcGroups.logic.ts).
import type {
  ConversationMessage,
  ConversationSummary,
  DeliveryState,
  ParticipantRef,
} from "./commsTypes";

const ALL_TAGS = ["all", "everyone"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The members a post can wake: everyone in the chat but the poster. */
export function wakeableMembers(
  members: ReadonlyArray<ParticipantRef>,
  self: string | null,
): ReadonlyArray<ParticipantRef> {
  return members.filter((member) => member.name !== self && member.kind !== "system");
}

/** The names @mentioned in the text, among the candidates. */
export function mentionedNames(
  text: string,
  candidates: ReadonlyArray<ParticipantRef>,
): ReadonlySet<string> {
  if (new RegExp(String.raw`(?<![\w@])@(?:${ALL_TAGS.join("|")})\b`, "i").test(text)) {
    return new Set(candidates.map((member) => member.name));
  }
  return new Set(
    candidates
      .filter((member) =>
        new RegExp(String.raw`(?<![\w@])@${escapeRegExp(member.name)}(?![\w-])`, "i").test(text),
      )
      .map((member) => member.name),
  );
}

/** Who a draft wakes, in member order: checked members unioned with mentions. */
export function draftRecipients(
  text: string,
  candidates: ReadonlyArray<ParticipantRef>,
  checked: ReadonlySet<string>,
): ReadonlyArray<string> {
  const mentioned = mentionedNames(text, candidates);
  return candidates
    .filter((member) => checked.has(member.name) || mentioned.has(member.name))
    .map((member) => member.name);
}

export function wakePreviewLabel(
  recipients: ReadonlyArray<string>,
  candidates: ReadonlyArray<ParticipantRef>,
): string {
  if (recipients.length === 0) return "Wakes nobody; the message only enters the transcript";
  if (recipients.length === candidates.length && candidates.length > 1) return "Wakes everyone";
  return `Wakes ${recipients.map((name) => `@${name}`).join(", ")}`;
}

export interface MentionQuery {
  /** Offset of the `@` in the text. */
  readonly start: number;
  /** Text typed after the `@`, up to the caret. */
  readonly query: string;
}

/** The `@word` being typed at the caret, or null when the caret isn't in one. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const match = /(^|[^\w@])@([\w-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export function mentionCandidates(
  candidates: ReadonlyArray<ParticipantRef>,
  query: string,
): ReadonlyArray<string> {
  const q = query.toLowerCase();
  return [...candidates.map((member) => member.name), ALL_TAGS[0]].filter((name) =>
    name.toLowerCase().startsWith(q),
  );
}

/** Replace the mention being typed with `@name ` and report the new caret. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  name: string,
): { readonly text: string; readonly caret: number } {
  const insert = `@${name} `;
  const end = mention.start + 1 + mention.query.length;
  return {
    text: `${text.slice(0, mention.start)}${insert}${text.slice(end)}`,
    caret: mention.start + insert.length,
  };
}

/** localStorage key for a chat's checked recipients. */
export function recipientsStorageKey(conversationId: string): string {
  return `t3code:comms:group:${conversationId}:recipients`;
}

/** Parse stored recipients; names no longer in the chat are dropped, bad JSON yields nothing. */
export function parseRecipients(
  raw: string | null | undefined,
  candidates: ReadonlyArray<ParticipantRef>,
): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const known = new Set(candidates.map((member) => member.name));
    return new Set(
      parsed.filter((name): name is string => typeof name === "string" && known.has(name)),
    );
  } catch {
    return new Set();
  }
}

/** A delivery still in flight: the agent has it, or is about to. */
const IN_FLIGHT: ReadonlySet<DeliveryState> = new Set(["pending", "claimed", "delivered"]);
/** A delivery that ended without an answer. */
const FAILED: ReadonlySet<DeliveryState> = new Set(["failed", "uncertain"]);

export type MemberActivity = "working" | "failed" | "idle";

/**
 * Each member's activity from the deliveries addressed to them in the loaded
 * messages: working while any request to them is still in flight (overlapping
 * requests; answers and notices end at `delivered`), else
 * failed when the latest ended without an answer, else idle.
 */
export function memberActivity(
  messages: ReadonlyArray<ConversationMessage>,
): ReadonlyMap<string, MemberActivity> {
  const latest = new Map<string, MemberActivity>();
  const working = new Set<string>();
  for (const { message, deliveries } of messages) {
    for (const delivery of deliveries) {
      // Only a request is work: an answer or notice ends at `delivered`.
      if (message.kind === "request" && IN_FLIGHT.has(delivery.state)) {
        working.add(delivery.recipient);
      }
      latest.set(delivery.recipient, FAILED.has(delivery.state) ? "failed" : "idle");
    }
  }
  for (const name of working) latest.set(name, "working");
  return latest;
}

export function deliveryLabel(state: DeliveryState): string {
  switch (state) {
    case "pending":
      return "waiting";
    case "claimed":
      return "picked up";
    case "delivered":
      return "working";
    case "replied":
      return "answered";
    case "ambiguous":
      return "unclear";
    case "uncertain":
      return "no answer";
    case "failed":
      return "failed";
  }
}

export function chatTitle(conversation: Pick<ConversationSummary, "title" | "members">): string {
  return conversation.title ?? conversation.members.map((member) => `@${member.name}`).join(", ");
}

/** Group chats, most recent first (the server's order), optionally only those a person is in. */
export function groupChats(
  conversations: ReadonlyArray<ConversationSummary>,
  member: string | null,
): ReadonlyArray<ConversationSummary> {
  return conversations.filter(
    (conversation) =>
      conversation.kind === "group" &&
      (member === null || conversation.members.some((m) => m.name === member)),
  );
}

/** localStorage key for the highest seq a person has seen in a chat on this device. */
export function seenStorageKey(conversationId: string): string {
  return `t3code:comms:group:${conversationId}:seenSeq`;
}
