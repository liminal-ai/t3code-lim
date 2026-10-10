// Fork-only (agent comms): the wire between the T3 web client and this
// server's /api/comms proxy. The comms server's own functions (names, argument
// and result shapes) belong to agent-comms (@agent-comms/protocol); this file
// types the envelope around them and the allowlist both sides share.
import * as Schema from "effect/Schema";

export const CommsFunctionKind = Schema.Literals(["query", "mutation"]);
export type CommsFunctionKind = typeof CommsFunctionKind.Type;

/** The comms server's admin functions the T3 UI may reach; never `connector:*`. */
export const COMMS_FUNCTIONS = {
  "directory:list": "query",
  "registry:list": "query",
  "conversations:list": "query",
  "conversations:view": "query",
  "inbox:list": "query",
  "inbox:unreadCount": "query",
  "reminders:list": "query",
  "reminders:get": "query",
  "alerts:list": "query",
  "alerts:config": "query",
  "directory:promote": "mutation",
  "directory:setState": "mutation",
  "directory:rebind": "mutation",
  "registry:setProfile": "mutation",
  "conversations:createGroup": "mutation",
  "conversations:openDm": "mutation",
  "conversations:addMember": "mutation",
  "conversations:removeMember": "mutation",
  "conversations:postAs": "mutation",
  // Group delete (Lee, 2026-10-09; Mira #258): permanently deletes the group
  // and all its messages for everyone.
  "conversations:deleteConversation": "mutation",
  "inbox:markRead": "mutation",
  "reminders:create": "mutation",
  "reminders:update": "mutation",
  "alerts:setConfig": "mutation",
} as const satisfies Readonly<Record<string, CommsFunctionKind>>;
export type CommsFunctionName = keyof typeof COMMS_FUNCTIONS;
export type CommsQueryName = {
  [K in CommsFunctionName]: (typeof COMMS_FUNCTIONS)[K] extends "query" ? K : never;
}[CommsFunctionName];
export type CommsMutationName = Exclude<CommsFunctionName, CommsQueryName>;

export const isCommsFunctionName = (name: unknown): name is CommsFunctionName =>
  typeof name === "string" && Object.hasOwn(COMMS_FUNCTIONS, name);

/** Arguments to a comms function, without `adminToken` (the server adds it). */
export const CommsArgs = Schema.Record(Schema.String, Schema.Unknown);
export type CommsArgs = typeof CommsArgs.Type;

/** `GET /api/comms/config`. */
export const CommsConfig = Schema.Struct({
  enabled: Schema.Boolean,
  testMode: Schema.Boolean,
  /** The person this UI posts as; null when unset (read-only). */
  postAs: Schema.NullOr(Schema.String),
  /** The comms machine whose connector drives this T3; null when unset. */
  homeMachine: Schema.NullOr(Schema.String),
});
export type CommsConfig = typeof CommsConfig.Type;

/** A failure as the page sees it: a comms refusal keeps its protocol `code`. */
export const CommsWireError = Schema.Struct({
  message: Schema.String,
  data: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
});
export type CommsWireError = typeof CommsWireError.Type;

/** `POST /api/comms/call`. */
export const CommsCallRequest = Schema.Struct({
  kind: Schema.optionalKey(CommsFunctionKind),
  name: Schema.String,
  args: Schema.optionalKey(CommsArgs),
});
export type CommsCallRequest = typeof CommsCallRequest.Type;

export const CommsCallResponse = Schema.Union([
  Schema.Struct({ value: Schema.Unknown }),
  Schema.Struct({ error: CommsWireError }),
]);
export type CommsCallResponse = typeof CommsCallResponse.Type;

export const COMMS_MAX_WATCH_QUERIES = 32;

export const CommsWatchQuery = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  args: Schema.optionalKey(CommsArgs),
});
export type CommsWatchQuery = typeof CommsWatchQuery.Type;

/** `POST /api/comms/watch`: one stream carries every live query. */
export const CommsWatchRequest = Schema.Struct({
  queries: Schema.Array(CommsWatchQuery),
});
export type CommsWatchRequest = typeof CommsWatchRequest.Type;

/** One NDJSON line of the watch stream; `{}` is a heartbeat. */
export const CommsWatchFrame = Schema.Union([
  Schema.Struct({ id: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ id: Schema.String, error: CommsWireError }),
  Schema.Struct({}),
]);
export type CommsWatchFrame = typeof CommsWatchFrame.Type;
