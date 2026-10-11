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
import {
  type ArtifactGuard,
  type ArtifactStore,
  ArtifactStoreError,
} from "../../../artifacts/ArtifactStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { ArtifactToolkit } from "./tools.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** A store call that failed in a way the store didn't anticipate (I/O, SQLite, git). */
class UnexpectedStoreFailure extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("unexpected artifact store failure");
    this.cause = cause;
  }
}

/** Store errors as tool failures; their messages are written for the agent. */
export const toFailure = (error: unknown) => {
  if (error instanceof ArtifactStoreError) {
    const revision = error.currentRevision ? ` Current revision: ${error.currentRevision}.` : "";
    return new OrchestratorMcpFailure({
      code:
        error.code === "unavailable"
          ? "orchestration_error"
          : error.code === "forbidden"
            ? "capability_denied"
            : "invalid_request",
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
    return yield* Effect.tryPromise({
      try: () => run(store),
      catch: (error) =>
        error instanceof ArtifactStoreError || error instanceof ArtifactPathError
          ? toFailure(error)
          : new UnexpectedStoreFailure(error),
    }).pipe(
      // Unexpected failures are logged here, since the agent is told to see the log.
      Effect.catchIf(
        (error): error is UnexpectedStoreFailure => error instanceof UnexpectedStoreFailure,
        (error) =>
          Effect.logError("artifact tool failed", error.cause).pipe(
            Effect.andThen(Effect.fail(toFailure(error.cause))),
          ),
      ),
    );
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
 * Lee, or a thread that may already edit it. The store checks it inside the
 * change's turn, so a link removed meanwhile can't be used.
 */
const requireWrite =
  (threadId: string, action: string): ArtifactGuard =>
  (artifact) => {
    if (accessOf(artifact, threadId) === "write") return;
    throw new ArtifactStoreError(
      "forbidden",
      `This thread can't ${action} "${artifact.title}": it isn't attached with write access. Ask Lee, or a thread attached with write access, to artifact_attach it here`,
    );
  };

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
      const { artifact, content, items } = yield* storeCall((store) => store.read(id));
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
      return yield* storeCall((store) =>
        store.applyOps(input.id, input.ops, actor, requireWrite(threadId, "edit")),
      );
    }),
  ),
  artifact_attach: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threadId, actor } = yield* callerActor;
        const target = yield* targetThread(input.threadId, threadId);
        const updated = yield* storeCall((store) =>
          store.attach(
            input.id,
            target,
            input.access ?? "write",
            actor,
            requireWrite(threadId, "attach"),
          ),
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
        // A thread may always leave an artifact; detaching others needs write.
        const guard =
          target === threadId ? undefined : requireWrite(threadId, "detach other threads from");
        const updated = yield* storeCall((store) => store.detach(input.id, target, actor, guard));
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
