// Fork-only (artifacts): the agent tools over the artifact store (PR 2 of
// the artifacts plan). Artifacts are files kept across threads; agents list,
// read, create and edit them, and attach them to threads, through these tools.
import {
  LimArtifactLinkAccess,
  LimArtifactListItem,
  LimArtifactListOp,
  LimArtifactSummary,
  LIM_ARTIFACT_MAX_OPS,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ArtifactStoreHandle } from "../../../artifacts/ArtifactHttp.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ArtifactStoreHandle,
  ],
};

const ArtifactId = Schema.String.annotate({
  description: "The artifact's id, from artifact_list.",
});

const ReadResult = Schema.Struct({
  artifact: LimArtifactSummary,
  content: Schema.String,
  items: Schema.Array(LimArtifactListItem),
});

const ITEMS_HELP =
  "A list is markdown: each top-level `- [ ]` / `- [x]` line is an item, its indented lines belong to it, and its id is the trailing `^xx`.";

export const ArtifactListTool = Tool.make("artifact_list", {
  ...shared,
  description:
    "List artifacts: files kept across threads, such as lists, specs and docs. By default, those attached to this thread; scope 'all' lists every artifact in this environment's store. Filter by tag, folder or text.",
  parameters: Schema.Struct({
    scope: Schema.optional(
      Schema.Literals(["thread", "all"]).annotate({
        description: "'thread' (default): attached to this thread. 'all': the whole store.",
      }),
    ),
    tag: Schema.optional(Schema.String),
    folder: Schema.optional(Schema.String),
    query: Schema.optional(
      Schema.String.annotate({ description: "Text to find in titles and bodies." }),
    ),
  }),
  success: Schema.Struct({ artifacts: Schema.Array(LimArtifactSummary) }),
})
  .annotate(Tool.Title, "List artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ArtifactReadTool = Tool.make("artifact_read", {
  ...shared,
  description: `Read an artifact by id or by its store path: its metadata, links, body and list items. ${ITEMS_HELP} Reading needs no attachment; editing does.`,
  parameters: Schema.Struct({
    id: Schema.optional(ArtifactId),
    path: Schema.optional(
      Schema.String.annotate({ description: "Path inside the store, e.g. `t3/backlog.md`." }),
    ),
  }),
  success: ReadResult,
})
  .annotate(Tool.Title, "Read an artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ArtifactCreateTool = Tool.make("artifact_create", {
  ...shared,
  description: `Create a markdown artifact, such as a list, spec or doc. It is attached to this thread with write access. ${ITEMS_HELP} Items get ids when created.`,
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    content: Schema.optional(Schema.String),
    folder: Schema.optional(
      Schema.String.annotate({
        description: "A folder inside the store, e.g. `t3` or `research/agents`.",
      }),
    ),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: ReadResult,
})
  .annotate(Tool.Title, "Create an artifact")
  .annotate(Tool.Destructive, false);

export const ArtifactPatchTool = Tool.make("artifact_patch", {
  ...shared,
  description:
    "Edit a list artifact with item ops, applied in order to the current file (all or none): add {text, at?: top|bottom|after:<id>}, edit {id, text}, check/uncheck {id}, move {id, to}, remove {id}. Concurrent edits by others merge; an op on an item someone removed fails with item_not_found. This thread needs write access (artifact_attach).",
  parameters: Schema.Struct({
    id: ArtifactId,
    ops: Schema.Array(LimArtifactListOp).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(LIM_ARTIFACT_MAX_OPS),
    ),
  }),
  success: Schema.Struct({
    artifact: LimArtifactSummary,
    items: Schema.Array(LimArtifactListItem),
    itemIds: Schema.Array(Schema.String).annotate({
      description: "The item each op touched, in order (for add, the new item's id).",
    }),
  }),
})
  .annotate(Tool.Title, "Edit a list")
  .annotate(Tool.Destructive, true);

export const ArtifactAttachTool = Tool.make("artifact_attach", {
  ...shared,
  description:
    "Attach an artifact to a thread (this one when threadId is omitted) with read or write access, so it shows in that thread's artifact_list and, with write, can be edited there. This thread needs write access to the artifact.",
  parameters: Schema.Struct({
    id: ArtifactId,
    threadId: Schema.optional(ThreadId),
    access: Schema.optional(LimArtifactLinkAccess.annotate({ description: "Default write." })),
  }),
  success: Schema.Struct({ artifact: LimArtifactSummary }),
})
  .annotate(Tool.Title, "Attach an artifact")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ArtifactDetachTool = Tool.make("artifact_detach", {
  ...shared,
  description:
    "Detach an artifact from a thread (this one when threadId is omitted). The artifact itself is kept. Detaching another thread needs write access to the artifact.",
  parameters: Schema.Struct({ id: ArtifactId, threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ artifact: LimArtifactSummary }),
})
  .annotate(Tool.Title, "Detach an artifact")
  .annotate(Tool.Destructive, true);

export const ArtifactToolkit = Toolkit.make(
  ArtifactListTool,
  ArtifactReadTool,
  ArtifactCreateTool,
  ArtifactPatchTool,
  ArtifactAttachTool,
  ArtifactDetachTool,
);
