import {
  type LimArtifactActor,
  type LimArtifactSummary,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ArtifactPathError } from "../../../artifacts/ArtifactFiles.ts";
import { ArtifactStoreHandle } from "../../../artifacts/ArtifactHttp.ts";
import { type ArtifactStore, ArtifactStoreError } from "../../../artifacts/ArtifactStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { ArtifactToolkit } from "./tools.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** Store errors as tool failures; their messages are written for the agent. */
export const toFailure = (error: unknown) => {
  if (error instanceof ArtifactStoreError) {
    const revision = error.currentRevision ? ` Current revision: ${error.currentRevision}.` : "";
    return new OrchestratorMcpFailure({
      code: error.code === "unavailable" ? "orchestration_error" : "invalid_request",
      message: `${error.code}: ${error.message}.${revision}`,
    });
  }
  if (error instanceof ArtifactPathError) {
    return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
  }
  if (isMcpFailure(error)) return error;
  return new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The artifact store failed; see the server log.",
  });
};

const storeCall = <A>(run: (store: ArtifactStore) => Promise<A>) =>
  Effect.gen(function* () {
    const handle = yield* ArtifactStoreHandle;
    const store = yield* handle.store.pipe(Effect.mapError(toFailure));
    return yield* Effect.tryPromise({ try: () => run(store), catch: toFailure });
  });

/** The calling thread, as the actor its edits are attributed to (author: its title). */
const callerActor = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Artifact tools");
  const { projection } = yield* readThread(thread.threadId);
  return {
    threadId: thread.threadId,
    actor: {
      kind: "agent",
      id: thread.threadId,
      name: projection.thread.title.trim() || `Thread ${thread.threadId.slice(0, 8)}`,
    } satisfies LimArtifactActor,
  };
});

const accessOf = (artifact: LimArtifactSummary, threadId: string) =>
  artifact.links.find((link) => link.threadId === threadId)?.access;

/**
 * Editing an artifact, or sharing it with another thread, needs a write link
 * from the calling thread: an artifact lands in a thread through its creator,
 * Lee, or a thread that may already edit it.
 */
const requireWrite = (artifact: LimArtifactSummary, threadId: string, action: string) =>
  accessOf(artifact, threadId) === "write"
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `This thread can't ${action} "${artifact.title}": it isn't attached with write access. Ask Lee, or a thread attached with write access, to artifact_attach it here.`,
        }),
      );

const readArtifact = (id: string) => storeCall((store) => store.read(id));

export const handlers = {
  artifact_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "artifact_list");
      const artifacts = yield* storeCall((store) =>
        store.list({
          threadId: (input.scope ?? "thread") === "thread" ? thread.threadId : undefined,
          tag: input.tag,
          folder: input.folder,
          query: input.query,
        }),
      );
      return { artifacts };
    }),
  ),
  artifact_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      if ((input.id === undefined) === (input.path === undefined)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass exactly one of id or path.",
        });
      }
      const id =
        input.id ??
        (yield* storeCall(
          async (store) => (await store.list()).find((a) => a.path === input.path)?.id,
        ));
      if (id === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `not_found: no artifact at ${input.path}.`,
        });
      }
      const { artifact, content, items } = yield* readArtifact(id);
      return { artifact, content, items };
    }),
  ),
  artifact_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, actor } = yield* callerActor;
      const { artifact, content, items } = yield* storeCall((store) =>
        store.create({ ...input, attach: [{ threadId, access: "write" }] }, actor),
      );
      return { artifact, content, items };
    }),
  ),
  artifact_patch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, actor } = yield* callerActor;
      const { artifact } = yield* readArtifact(input.id);
      yield* requireWrite(artifact, threadId, "edit");
      return yield* storeCall((store) => store.applyOps(input.id, input.ops, actor));
    }),
  ),
  artifact_attach: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threadId, actor } = yield* callerActor;
        const target = yield* targetThread(input.threadId, threadId);
        const { artifact } = yield* readArtifact(input.id);
        yield* requireWrite(artifact, threadId, "attach");
        const updated = yield* storeCall((store) =>
          store.attach(input.id, target, input.access ?? "write", actor),
        );
        return { artifact: updated };
      }),
  ),
  artifact_detach: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threadId, actor } = yield* callerActor;
        const target = yield* targetThread(input.threadId, threadId);
        const { artifact } = yield* readArtifact(input.id);
        // A thread may always leave an artifact; detaching others needs write.
        if (target !== threadId)
          yield* requireWrite(artifact, threadId, "detach other threads from");
        const updated = yield* storeCall((store) => store.detach(input.id, target, actor));
        return { artifact: updated };
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof ArtifactToolkit.tools>;

/** The target thread: the caller's own when omitted; another must exist. */
const targetThread = (requested: ThreadId | undefined, caller: ThreadId) =>
  requested === undefined || requested === caller
    ? Effect.succeed(caller as string)
    : readThread(requested).pipe(Effect.as(requested as string));

export const layer = McpToolAccess.toLayer(ArtifactToolkit, handlers);
