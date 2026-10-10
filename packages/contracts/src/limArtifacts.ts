// Fork-only (artifacts): the wire between T3 clients and this server's
// /api/artifacts routes. Artifacts are files kept across threads in a
// git-versioned store beside the server's data; lists are markdown checklists
// that Lee and agents edit item by item. See fork/README.md (Artifacts).
import * as Schema from "effect/Schema";

export const LIM_ARTIFACTS_ROUTE_PREFIX = "/api/artifacts";

/** Kind comes from the file extension. PR 1 creates markdown only. */
export const LimArtifactKind = Schema.Literals(["md", "html", "other"]);
export type LimArtifactKind = typeof LimArtifactKind.Type;

/** PR 1 keeps everything; transient and archived arrive with the lifecycle work. */
export const LimArtifactState = Schema.Literals(["transient", "kept", "archived"]);
export type LimArtifactState = typeof LimArtifactState.Type;

export const LimArtifactLinkAccess = Schema.Literals(["read", "write"]);
export type LimArtifactLinkAccess = typeof LimArtifactLinkAccess.Type;

/** Who made a change: Lee in the UI, an agent thread, or an edit made outside T3. */
export const LimArtifactActor = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "external", "system"]),
  id: Schema.String,
  name: Schema.String,
});
export type LimArtifactActor = typeof LimArtifactActor.Type;

export const LimArtifactLink = Schema.Struct({
  threadId: Schema.String,
  access: LimArtifactLinkAccess,
  linkedBy: LimArtifactActor,
  linkedAt: Schema.String,
});
export type LimArtifactLink = typeof LimArtifactLink.Type;

export const LimArtifactSummary = Schema.Struct({
  id: Schema.String,
  /** Relative to the store, with `/` separators. */
  path: Schema.String,
  /** Where agents on this machine can read the file directly. */
  absolutePath: Schema.String,
  title: Schema.String,
  kind: LimArtifactKind,
  state: LimArtifactState,
  tags: Schema.Array(Schema.String),
  /** Content hash; changes with every edit. */
  revision: Schema.String,
  size: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Schema.NullOr(LimArtifactActor),
  links: Schema.Array(LimArtifactLink),
});
export type LimArtifactSummary = typeof LimArtifactSummary.Type;

/** The last change to one list item, for "last change per item". */
export const LimArtifactItemChange = Schema.Struct({
  at: Schema.String,
  action: Schema.String,
  actor: LimArtifactActor,
});
export type LimArtifactItemChange = typeof LimArtifactItemChange.Type;

/** One top-level `- [ ]` / `- [x]` line of a markdown artifact. */
export const LimArtifactListItem = Schema.Struct({
  /** Null until the next T3 write assigns one (send `ops: []` to assign now). */
  id: Schema.NullOr(Schema.String),
  checked: Schema.Boolean,
  text: Schema.String,
  /** Inline `#tags` in the item text. */
  tags: Schema.Array(Schema.String),
  /** Indented lines under the item, verbatim. */
  details: Schema.String,
  lastChange: Schema.NullOr(LimArtifactItemChange),
});
export type LimArtifactListItem = typeof LimArtifactListItem.Type;

/** Which T3 server and store this is, so the page can say so in its header. */
export const LimArtifactStoreInfo = Schema.Struct({
  environmentId: Schema.String,
  environmentName: Schema.String,
  storeDir: Schema.String,
});
export type LimArtifactStoreInfo = typeof LimArtifactStoreInfo.Type;

/** `GET /api/artifacts` (filters: `thread`, `tag`, `folder`, `kind`, `q`). */
export const LimArtifactListResponse = Schema.Struct({
  store: LimArtifactStoreInfo,
  artifacts: Schema.Array(LimArtifactSummary),
});
export type LimArtifactListResponse = typeof LimArtifactListResponse.Type;

/** `GET /api/artifacts/:id`. */
export const LimArtifactReadResponse = Schema.Struct({
  store: LimArtifactStoreInfo,
  artifact: LimArtifactSummary,
  /** The file's body, without its front matter. */
  content: Schema.String,
  items: Schema.Array(LimArtifactListItem),
});
export type LimArtifactReadResponse = typeof LimArtifactReadResponse.Type;

export const LimArtifactAttachRequest = Schema.Struct({
  threadId: Schema.String,
  access: Schema.optionalKey(LimArtifactLinkAccess),
});
export type LimArtifactAttachRequest = typeof LimArtifactAttachRequest.Type;

/** `POST /api/artifacts`: a new markdown artifact (a list is markdown with checklist items). */
export const LimArtifactCreateRequest = Schema.Struct({
  title: Schema.String,
  content: Schema.optionalKey(Schema.String),
  /** A folder inside the store, e.g. `t3` or `research/agents`. */
  folder: Schema.optionalKey(Schema.String),
  /** File name inside the folder; derived from the title when omitted. */
  name: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  attach: Schema.optionalKey(Schema.Array(LimArtifactAttachRequest)),
});
export type LimArtifactCreateRequest = typeof LimArtifactCreateRequest.Type;

/** Where an added or moved item goes: `top`, `bottom`, or `after:<id>`. */
export const LimArtifactListPosition = Schema.String;

export const LimArtifactListOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    text: Schema.String,
    at: Schema.optionalKey(LimArtifactListPosition),
  }),
  Schema.Struct({ op: Schema.Literal("edit"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ op: Schema.Literal("check"), id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("uncheck"), id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("move"), id: Schema.String, to: LimArtifactListPosition }),
  Schema.Struct({ op: Schema.Literal("remove"), id: Schema.String }),
]);
export type LimArtifactListOp = typeof LimArtifactListOp.Type;

export const LIM_ARTIFACT_MAX_OPS = 100;

/** `POST /api/artifacts/:id/ops`: applied in order to the current file, all or none. */
export const LimArtifactOpsRequest = Schema.Struct({
  ops: Schema.Array(LimArtifactListOp),
});
export type LimArtifactOpsRequest = typeof LimArtifactOpsRequest.Type;

export const LimArtifactOpsResponse = Schema.Struct({
  artifact: LimArtifactSummary,
  items: Schema.Array(LimArtifactListItem),
  /** The id each op touched, in order (for `add`, the new item's id). */
  itemIds: Schema.Array(Schema.String),
});
export type LimArtifactOpsResponse = typeof LimArtifactOpsResponse.Type;

/** A failure; `currentRevision` comes with not-found items so callers can re-read. */
export const LimArtifactWireError = Schema.Struct({
  message: Schema.String,
  code: Schema.String,
  currentRevision: Schema.optionalKey(Schema.String),
});
export type LimArtifactWireError = typeof LimArtifactWireError.Type;

export const LIM_ARTIFACT_MAX_WATCH_IDS = 256;

/** `POST /api/artifacts/watch`: changes to the listed artifacts, or to all when `ids` is omitted. */
export const LimArtifactWatchRequest = Schema.Struct({
  ids: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type LimArtifactWatchRequest = typeof LimArtifactWatchRequest.Type;

export const LimArtifactChange = Schema.Struct({
  seq: Schema.Number,
  artifactId: Schema.String,
  at: Schema.String,
  action: Schema.String,
  actor: LimArtifactActor,
  summary: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  /** The artifact's revision after the change; null when it was removed. */
  revision: Schema.NullOr(Schema.String),
});
export type LimArtifactChange = typeof LimArtifactChange.Type;

/**
 * One NDJSON line of the watch stream: `{ready}` first, then one `{change}` per
 * change; `{resync}` means changes were dropped for a slow reader (re-read);
 * `{}` is a heartbeat.
 */
export const LimArtifactWatchFrame = Schema.Union([
  Schema.Struct({ ready: Schema.Struct({ seq: Schema.Number }) }),
  Schema.Struct({ change: LimArtifactChange }),
  Schema.Struct({ resync: Schema.Boolean }),
  Schema.Struct({}),
]);
export type LimArtifactWatchFrame = typeof LimArtifactWatchFrame.Type;
