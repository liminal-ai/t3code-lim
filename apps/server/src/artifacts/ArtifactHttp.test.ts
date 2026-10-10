import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  type LimArtifactWatchFrame,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ArtifactHttp from "./ArtifactHttp.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (options: { readonly scopes?: ReadonlyArray<AuthEnvironmentScope> } = {}) => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "artifact-http-"));
  const dir = NodePath.join(base, "artifacts");
  const { handler, dispose } = HttpRouter.toWebHandler(
    ArtifactHttp.routeLayer.pipe(
      Layer.provideMerge(
        Layer.effect(ArtifactHttp.ArtifactStoreHandle, ArtifactHttp.makeStoreHandle(dir)),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "lee-session",
              method: "browser-session-cookie",
              scopes: options.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.die("unused"),
          getDescriptor: Effect.succeed({ environmentId: "env-1", label: "lim-builder" }),
        } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(async () => {
    await dispose();
    NodeFS.rmSync(base, { recursive: true, force: true });
  });
  const request = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://t3.test/api/artifacts${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );
  return { dir, handler, request };
};

const json = async (response: Response) => (await response.json()) as any;

/** Reads NDJSON frames from a stream until `until` says stop. */
const readFrames = async (
  response: Response,
  until: (frames: LimArtifactWatchFrame[]) => boolean,
) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: LimArtifactWatchFrame[] = [];
  let buffered = "";
  while (!until(frames)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  }
  await reader.cancel();
  return frames;
};

describe("artifact routes", () => {
  it("creates, lists, reads, edits and links a list, naming the environment and store", async () => {
    const { dir, request } = fixture();
    const created = await request("POST", "", {
      title: "Backlog",
      folder: "t3",
      content: "- [ ] a\n",
    });
    expect(created.status).toBe(201);
    const { artifact } = await json(created);
    expect(artifact.path).toBe("t3/backlog.md");
    expect(artifact.createdBy).toEqual({ kind: "user", id: "lee-session", name: "Lee" });

    const list = await json(await request("GET", "?folder=t3"));
    expect(list.store).toEqual({
      environmentId: "env-1",
      environmentName: "lim-builder",
      storeDir: dir,
    });
    expect(list.artifacts.map((entry: { id: string }) => entry.id)).toEqual([artifact.id]);

    const ops = await json(
      await request("POST", `/${artifact.id}/ops`, { ops: [{ op: "add", text: "b", at: "top" }] }),
    );
    expect(ops.items.map((item: { text: string }) => item.text)).toEqual(["b", "a"]);

    const linked = await request("POST", `/${artifact.id}/links`, { threadId: "thread-1" });
    expect((await json(linked)).artifact.links[0]).toMatchObject({
      threadId: "thread-1",
      access: "write",
    });
    expect((await json(await request("GET", "?thread=thread-1"))).artifacts).toHaveLength(1);
    const detached = await request("DELETE", `/${artifact.id}/links/thread-1`);
    expect((await json(detached)).artifact.links).toEqual([]);

    const read = await json(await request("GET", `/${artifact.id}`));
    expect(read.store.environmentName).toBe("lim-builder");
    expect(read.content).toMatch(/^- \[ \] b \^\w+\n- \[ \] a \^\w+\n$/);
  });

  it("answers errors with a code, and not-found items with the current revision", async () => {
    const { request } = fixture();
    const { artifact } = await json(
      await request("POST", "", { title: "L", content: "- [ ] a ^aa\n" }),
    );
    const missing = await request("POST", `/${artifact.id}/ops`, {
      ops: [{ op: "check", id: "zz" }],
    });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toEqual({
      code: "item_not_found",
      message: "no item ^zz in this list",
      currentRevision: artifact.revision,
    });
    expect((await request("GET", "/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(404);
    expect((await request("GET", "/nope")).status).toBe(404);
    expect((await request("PUT", `/${artifact.id}`)).status).toBe(405);
    expect((await request("POST", "", { nope: true })).status).toBe(400);
    expect((await request("GET", "?kind=pdf")).status).toBe(400);
    const tooMany = { ops: Array.from({ length: 101 }, () => ({ op: "add", text: "x" })) };
    expect((await request("POST", `/${artifact.id}/ops`, tooMany)).status).toBe(400);
  });

  it.each([
    { folder: "../outside" },
    { folder: "/etc" },
    { folder: ".git" },
    { name: "../../x.md" },
  ])("refuses a path that leaves the store: %j", async (input) => {
    const { request } = fixture();
    const response = await request("POST", "", { title: "x", ...input });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toMatch(/invalid_path|invalid_request/);
  });

  it("requires read scope to read and operate scope to write", async () => {
    const readOnly = fixture({ scopes: [AuthOrchestrationReadScope] });
    expect((await readOnly.request("GET", "")).status).toBe(200);
    expect((await readOnly.request("POST", "", { title: "x" })).status).toBe(403);
    const none = fixture({ scopes: [] });
    expect((await none.request("GET", "")).status).toBe(403);
    expect((await none.request("POST", "/watch", {})).status).toBe(403);
  });

  it("streams every change to a watcher, filtered by id", async () => {
    const { request } = fixture();
    const one = (await json(await request("POST", "", { title: "One" }))).artifact;
    const two = (await json(await request("POST", "", { title: "Two" }))).artifact;
    const all = await request("POST", "/watch", {});
    const onlyTwo = await request("POST", "/watch", { ids: [two.id] });
    expect(all.headers.get("content-type")).toContain("application/x-ndjson");
    for (let index = 0; index < 5; index++) {
      await request("POST", `/${one.id}/ops`, { ops: [{ op: "add", text: `item ${index}` }] });
    }
    await request("POST", `/${two.id}/links`, { threadId: "thread-2" });
    const changes = (frames: LimArtifactWatchFrame[]) =>
      frames.flatMap((frame) => ("change" in frame ? [frame.change] : []));
    const allFrames = await readFrames(all, (frames) => changes(frames).length >= 6);
    expect("ready" in allFrames[0]!).toBe(true);
    expect(changes(allFrames).map((change) => change.action)).toEqual([
      "add",
      "add",
      "add",
      "add",
      "add",
      "attached",
    ]);
    const twoFrames = await readFrames(onlyTwo, (frames) => changes(frames).length >= 1);
    expect(changes(twoFrames).map((change) => [change.artifactId, change.action])).toEqual([
      [two.id, "attached"],
    ]);
  });
});
