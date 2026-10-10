// Fork-only (agent comms): which comms server functions the browser may reach
// through this T3 server, and the test-mode rules that keep a development
// instance on clearly marked test participants. Pure: the proxy supplies the
// conversation lookups.
//
// Test naming (Lee, 2026-10-07): test agents start `ta-`, test groups `tg-`.
// The person in test conversations is the configured post-as person (Lee is
// the only human; no test people).

export { COMMS_FUNCTIONS } from "@t3tools/contracts";

export const TEST_AGENT_PREFIX = "ta-";
export const TEST_GROUP_PREFIX = "tg-";

export interface TestModeOptions {
  /** The only machine test agents may be homed on, e.g. `lim-builder-jess`. */
  readonly testMachine: string | undefined;
  /** The one person allowed in test conversations: the UI's post-as person. */
  readonly human: string | undefined;
  /**
   * This instance's own test agents (`ownTestAgents`). When given, a `ta-` name
   * counts only if it's one of them; the proxy passes it wherever it has the registry.
   */
  readonly ownAgents?: ReadonlySet<string> | undefined;
}

/** A `ta-` agent (one of this instance's, when known), or the configured person. */
export const isTestParticipant = (name: string, options: TestModeOptions): boolean =>
  (name.startsWith(TEST_AGENT_PREFIX) && (!options.ownAgents || options.ownAgents.has(name))) ||
  (options.human !== undefined && name === options.human);

/** The fields of a conversation summary the rules read. */
export interface PolicyConversation {
  readonly kind: string;
  readonly title?: string | undefined;
  readonly members: ReadonlyArray<{ readonly name: string }>;
}

/** A test conversation: a `tg-` group, or a DM, whose members are all test participants. */
export const isTestConversation = (
  conversation: PolicyConversation,
  options: TestModeOptions,
): boolean =>
  (conversation.kind !== "group" || (conversation.title ?? "").startsWith(TEST_GROUP_PREFIX)) &&
  conversation.members.length > 0 &&
  conversation.members.every((member) => isTestParticipant(member.name, options));

/** Test mode refuses these outright: they reach beyond test participants. */
const TEST_MODE_REFUSED = new Set([
  "reminders:create",
  "reminders:update",
  "alerts:setConfig",
  "inbox:list",
  "inbox:unreadCount",
  "reminders:list",
  "reminders:get",
  "alerts:list",
  "alerts:config",
]);

/** Calls whose `conversationId` must name a test conversation (checked by the proxy). */
export const CONVERSATION_SCOPED = new Set([
  "conversations:view",
  "conversations:addMember",
  "conversations:removeMember",
  "conversations:postAs",
  "inbox:markRead",
]);

/** Calls whose `conversationIds` must each name a test conversation (checked by the proxy). */
export const CONVERSATIONS_SCOPED = new Set([
  "conversations:archiveConversation",
  "conversations:unarchiveConversation",
]);

type Args = Readonly<Record<string, unknown>>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The test-mode refusal for a call's own arguments, or undefined when allowed.
 * Conversation-scoped calls also need `isTestConversation` on the target.
 */
export function testModeRefusal(
  name: string,
  args: Args,
  options: TestModeOptions,
): string | undefined {
  if (TEST_MODE_REFUSED.has(name)) return `${name} is unavailable in test mode`;
  const needTest = (field: string, value: unknown): string | undefined =>
    isTestParticipant(str(value), options)
      ? undefined
      : `test mode: ${field} must be a ${TEST_AGENT_PREFIX}* agent or @${options.human ?? "(no post-as person)"}`;
  const needAgent = (field: string, value: unknown): string | undefined =>
    str(value).startsWith(TEST_AGENT_PREFIX)
      ? undefined
      : `test mode: ${field} must be a ${TEST_AGENT_PREFIX}* agent`;
  switch (name) {
    case "directory:promote": {
      if (str(args.kind) !== "agent") return "test mode: only test agents can be registered";
      if (!str(args.name).startsWith(TEST_AGENT_PREFIX)) {
        return `test mode: a test agent is named ${TEST_AGENT_PREFIX}*`;
      }
      if (!options.human || str(args.owner) !== options.human) {
        return `test mode: a test agent's owner is @${options.human ?? "(no post-as person)"}`;
      }
      return homeRefusal(args.home, options);
    }
    case "directory:rebind":
      return needAgent("name", args.name) ?? homeRefusal(args.home, options);
    case "directory:setState":
    case "registry:setProfile":
      return needAgent("name", args.name);
    case "conversations:createGroup": {
      if (!str(args.title).startsWith(TEST_GROUP_PREFIX)) {
        return `test mode: a test group's title starts ${TEST_GROUP_PREFIX}`;
      }
      const members = Array.isArray(args.members) ? args.members : [];
      return members.every((member) => isTestParticipant(str(member), options))
        ? undefined
        : "test mode: every member must be a test participant";
    }
    case "conversations:openDm":
      return needTest("a", args.a) ?? needTest("b", args.b);
    case "conversations:addMember":
    case "conversations:removeMember":
      return needTest("name", args.name);
    case "conversations:postAs": {
      if (!options.human || str(args.as) !== options.human) {
        return `test mode: post as @${options.human ?? "(no post-as person)"}`;
      }
      const to = Array.isArray(args.to) ? args.to : [];
      return to.every((recipient) => isTestParticipant(str(recipient), options))
        ? undefined
        : "test mode: every recipient must be a test participant";
    }
    case "conversations:archiveConversation":
    case "conversations:unarchiveConversation": {
      if (!options.human || str(args.as) !== options.human) {
        return `test mode: archive as @${options.human ?? "(no post-as person)"}`;
      }
      const ids = Array.isArray(args.conversationIds) ? args.conversationIds : [];
      return ids.length > 0 && ids.every((id) => typeof id === "string")
        ? undefined
        : "test mode: conversationIds must list at least one conversation";
    }
    case "inbox:markRead":
      // Opening a test chat clears the person's inbox items for it; nothing wider.
      if (!options.human || str(args.human) !== options.human) {
        return `test mode: only @${options.human ?? "(no post-as person)"}'s inbox`;
      }
      return typeof args.conversationId === "string" && !args.messageIds && !args.all
        ? undefined
        : "test mode: mark read one test conversation at a time";
    default:
      return undefined;
  }
}

function homeRefusal(home: unknown, options: TestModeOptions): string | undefined {
  const machine = str((home as { machine?: unknown } | undefined)?.machine);
  if (!options.testMachine) return "test mode: no test machine is configured";
  return machine === options.testMachine
    ? undefined
    : `test mode: test agents are homed on ${options.testMachine}`;
}

/** Test mode lists only test conversations. */
export function filterTestConversations<T extends PolicyConversation>(
  conversations: ReadonlyArray<T>,
  options: TestModeOptions,
): ReadonlyArray<T> {
  return conversations.filter((conversation) => isTestConversation(conversation, options));
}

/** Calls on an existing agent: test mode also checks who owns it and where it lives. */
export const AGENT_SCOPED = new Set([
  "directory:rebind",
  "directory:setState",
  "registry:setProfile",
]);

/** The fields of a registry entry the agent check reads. */
export interface PolicyAgent {
  readonly owner?: { readonly name: string } | undefined;
  readonly home?: { readonly machine: string } | undefined;
}

/**
 * Test mode changes only test agents this instance made: owned by the post-as
 * person and homed on the test machine. A `ta-` name alone isn't enough; another
 * test instance's agents are off limits.
 */
export function ownTestAgentRefusal(
  name: string,
  entry: PolicyAgent | undefined,
  options: TestModeOptions,
): string | undefined {
  if (!entry) return `test mode: @${name} isn't registered`;
  if (!options.human || entry.owner?.name !== options.human) {
    return `test mode: @${name} isn't owned by @${options.human ?? "(no post-as person)"}`;
  }
  if (!options.testMachine || entry.home?.machine !== options.testMachine) {
    return `test mode: @${name} isn't homed on ${options.testMachine ?? "(no test machine)"}`;
  }
  return undefined;
}

/**
 * What test mode lets a query return: lists trimmed to test conversations, and a
 * conversation view only while it's still a test conversation (it's rechecked on
 * every update, so a group renamed or given a real member stops streaming).
 */
export function shapeTestModeValue(
  name: string,
  value: unknown,
  options: TestModeOptions,
): { readonly value: unknown } | { readonly error: string } {
  if (name === "conversations:list") {
    const list = value as { conversations: ReadonlyArray<PolicyConversation> };
    return {
      value: { ...list, conversations: filterTestConversations(list.conversations, options) },
    };
  }
  if (name === "conversations:view") {
    const view = value as { conversation: PolicyConversation };
    return isTestConversation(view.conversation, options)
      ? { value }
      : { error: "test mode: that conversation isn't a test conversation" };
  }
  return { value };
}

/**
 * A comms failure for the page. A ConvexError carrying `{code, message}` is the
 * server refusing on purpose (its `fail()`), so that text passes. Anything else is
 * withheld: Convex error text can echo a call's arguments, the admin token among
 * them (agent-comms packages/connector/src/server-api.ts describeFailure). The
 * token is also scrubbed from whatever passes, as a backstop.
 */
export function describeCommsError(
  error: unknown,
  secret: string | undefined,
): { readonly message: string; readonly code?: string } {
  const scrub = (text: string) =>
    (secret ? text.split(secret).join("[redacted]") : text).slice(0, 1_000);
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    const { code, message } = data as { code: string; message?: unknown };
    return { code, message: scrub(typeof message === "string" ? message : code) };
  }
  const text = error instanceof Error ? error.message : String(error);
  const known =
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|timed out|WebSocket|connection (?:lost|closed))\b/i.exec(
      text,
    );
  return {
    message: known
      ? `comms server unavailable (${known[1]})`
      : "comms server error (details withheld; they may echo arguments)",
  };
}

/**
 * The test agents a call names, which test mode checks against this instance's
 * own agents (`ownTestAgentRefusal`): a `ta-` prefix alone would let a test group
 * include, or a post wake, another instance's test agent.
 */
export function namedTestAgents(name: string, args: Args): ReadonlyArray<string> {
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(str) : [str(value)];
  const named =
    name === "conversations:createGroup"
      ? names(args.members)
      : name === "conversations:postAs"
        ? names(args.to)
        : name === "conversations:openDm"
          ? [str(args.a), str(args.b)]
          : name === "conversations:addMember" || AGENT_SCOPED.has(name)
            ? [str(args.name)]
            : [];
  return [...new Set(named.filter((n) => n.startsWith(TEST_AGENT_PREFIX)))];
}

/** The names of the registry's test agents this instance owns and homes. */
export function ownTestAgents(
  agents: ReadonlyArray<PolicyAgent & { readonly participant: { readonly name: string } }>,
  options: TestModeOptions,
): ReadonlySet<string> {
  return new Set(
    agents
      .filter(
        (agent) =>
          agent.participant.name.startsWith(TEST_AGENT_PREFIX) &&
          ownTestAgentRefusal(agent.participant.name, agent, options) === undefined,
      )
      .map((agent) => agent.participant.name),
  );
}
