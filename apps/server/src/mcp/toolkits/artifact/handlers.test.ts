// @effect-diagnostics nodeBuiltinImport:off - the store under test is a Node filesystem and git boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ArtifactStoreHandle } from "../../../artifacts/ArtifactHttp.ts";
import { ArtifactStore } from "../../../artifacts/ArtifactStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ArtifactHandlers from "./handlers.ts";
import { ArtifactToolkit } from "./tools.ts";

const CLAUDE = ThreadId.make("thread-claude");
const CODEX = ThreadId.make("thread-codex");
const OUTSIDER = ThreadId.make("thread-outsider");
const TITLES: Record<string, string> = {
  [CLAUDE]: "Alder: backlog",
  [CODEX]: "Codex helper",
  [OUTSIDER]: "Unrelated",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const shell = (id: ThreadId) => ({
  ...McpToolAccessTestkit.liveThreadShell(id),
  title: TITLES[id] ?? id,
});

const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (id) => Effect.succeed(id in TITLES ? shell(id) : null),
  getProjectThreadRecords: (input) =>
    Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell(input.threadId)) as never),
});

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const makeHarness = Effect.gen(function* () {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "artifact-tools-"));
  const store = yield* Effect.promise(() => ArtifactStore.open(NodePath.join(dir, "artifacts")));
  cleanups.push(() => {
    store.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  const dependencies = Layer.mergeAll(
    threadsLayer,
    Layer.succeed(ArtifactStoreHandle, { dir: store.root, store: Effect.succeed(store) }),
  );
  const toolkit = yield* ArtifactToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ArtifactHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  /** The tool's result, or its returned failure (failure mode "return"). */
  const call = <Name extends keyof typeof ArtifactToolkit.tools>(
    threadId: ThreadId,
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)! as { isFailure: boolean; result: any }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
      Effect.provide(dependencies),
    );
  return { store, call };
});

const ok = <T extends { isFailure: boolean; result: any }>(response: T) => {
  expect(response.isFailure, JSON.stringify(response.result)).toBe(false);
  return response.result;
};

describe("artifact toolkit handlers", () => {
  it.effect("creates a list attached to the calling thread, authored as its title", () =>
    Effect.gen(function* () {
      const { store, call } = yield* makeHarness;
      const created = ok(
        yield* call(CLAUDE, "artifact_create", { title: "Backlog", content: "- [ ] a\n" }),
      );
      expect(created.artifact.links).toMatchObject([{ threadId: CLAUDE, access: "write" }]);
      expect(created.artifact.createdBy).toEqual({
        kind: "agent",
        id: CLAUDE,
        name: "Alder: backlog",
      });
      const author = NodeChildProcess.execFileSync("git", ["log", "-1", "--format=%an"], {
        cwd: store.root,
        encoding: "utf8",
      }).trim();
      expect(author).toBe("Alder: backlog");
      const listed = ok(yield* call(CLAUDE, "artifact_list", {}));
      expect(listed.artifacts.map((a: { id: string }) => a.id)).toEqual([created.artifact.id]);
      expect(ok(yield* call(CODEX, "artifact_list", {})).artifacts).toEqual([]);
      expect(ok(yield* call(CODEX, "artifact_list", { scope: "all" })).artifacts).toHaveLength(1);
    }),
  );

  it.effect("lets a thread attached with write edit the list, and no one else", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const { artifact } = ok(yield* call(CLAUDE, "artifact_create", { title: "Shared" }));
      const denied = yield* call(CODEX, "artifact_patch", {
        id: artifact.id,
        ops: [{ op: "add", text: "nope" }],
      });
      expect(denied).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
      // An unattached thread can't attach itself either.
      expect(yield* call(OUTSIDER, "artifact_attach", { id: artifact.id })).toMatchObject({
        isFailure: true,
        result: { code: "capability_denied" },
      });

      // Once a thread with write attaches it there, the other thread may edit.
      ok(yield* call(CLAUDE, "artifact_attach", { id: artifact.id, threadId: CODEX }));
      ok(
        yield* call(CODEX, "artifact_patch", { id: artifact.id, ops: [{ op: "add", text: "ok" }] }),
      );
    }),
  );

  it.effect("applies ops from an attached thread and names their items", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const { artifact } = ok(yield* call(CLAUDE, "artifact_create", { title: "Shared" }));
      ok(
        yield* call(CLAUDE, "artifact_attach", {
          id: artifact.id,
          threadId: CODEX,
          access: "write",
        }),
      );
      const patched = ok(
        yield* call(CODEX, "artifact_patch", {
          id: artifact.id,
          ops: [{ op: "add", text: "from codex" }],
        }),
      );
      expect(patched.items.map((item: { text: string }) => item.text)).toEqual(["from codex"]);
      const [itemId] = patched.itemIds;
      const checked = ok(
        yield* call(CODEX, "artifact_patch", {
          id: artifact.id,
          ops: [{ op: "check", id: itemId }],
        }),
      );
      expect(checked.items[0]).toMatchObject({
        checked: true,
        lastChange: { action: "check", actor: { kind: "agent", id: CODEX, name: "Codex helper" } },
      });
      // A read link doesn't allow edits.
      ok(
        yield* call(CLAUDE, "artifact_attach", {
          id: artifact.id,
          threadId: OUTSIDER,
          access: "read",
        }),
      );
      expect(
        yield* call(OUTSIDER, "artifact_patch", {
          id: artifact.id,
          ops: [{ op: "add", text: "x" }],
        }),
      ).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
    }),
  );

  it.effect("reads by id or path, and reports a removed item with the current revision", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const created = ok(
        yield* call(CLAUDE, "artifact_create", {
          title: "Plan",
          folder: "t3",
          content: "- [ ] a\n",
        }),
      );
      const byPath = ok(yield* call(OUTSIDER, "artifact_read", { path: "t3/plan.md" }));
      expect(byPath.artifact.id).toBe(created.artifact.id);
      expect(
        yield* call(OUTSIDER, "artifact_read", { id: created.artifact.id, path: "t3/plan.md" }),
      ).toMatchObject({ isFailure: true, result: { code: "invalid_request" } });
      const [item] = created.items;
      ok(
        yield* call(CLAUDE, "artifact_patch", {
          id: created.artifact.id,
          ops: [{ op: "remove", id: item.id }],
        }),
      );
      const missing = yield* call(CLAUDE, "artifact_patch", {
        id: created.artifact.id,
        ops: [{ op: "check", id: item.id }],
      });
      expect(missing.isFailure).toBe(true);
      expect(missing.result.message).toMatch(/^item_not_found: .*Current revision: /);
    }),
  );

  it.effect("lets a thread leave an artifact, but detaching others needs write", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const { artifact } = ok(yield* call(CLAUDE, "artifact_create", { title: "Leave" }));
      ok(
        yield* call(CLAUDE, "artifact_attach", {
          id: artifact.id,
          threadId: OUTSIDER,
          access: "read",
        }),
      );
      expect(
        yield* call(OUTSIDER, "artifact_detach", { id: artifact.id, threadId: CLAUDE }),
      ).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
      const left = ok(yield* call(OUTSIDER, "artifact_detach", { id: artifact.id }));
      expect(left.artifact.links.map((link: { threadId: string }) => link.threadId)).toEqual([
        CLAUDE,
      ]);
      expect(
        yield* call(CLAUDE, "artifact_attach", {
          id: artifact.id,
          threadId: ThreadId.make("thread-gone"),
        }),
      ).toMatchObject({ isFailure: true, result: { code: "thread_not_found" } });
    }),
  );
});
