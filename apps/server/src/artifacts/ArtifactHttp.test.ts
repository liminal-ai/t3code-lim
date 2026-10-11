// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
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
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ArtifactHttp from "./ArtifactHttp.ts";
import { signViewToken, VIEW_KEY_SECRET_NAME } from "./ArtifactViewTokens.ts";

/** The test servers' view-link key. */
const VIEW_KEY = new Uint8Array(32).fill(7);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (options: { readonly scopes?: ReadonlyArray<AuthEnvironmentScope> } = {}) => {
  const secretsAsked: string[] = [];
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
      Layer.provideMerge(
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          getOrCreateRandom: (name: string) => {
            secretsAsked.push(name);
            return Effect.succeed(VIEW_KEY);
          },
        } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
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
  /** A request to any path on the server, e.g. `/a/<token>`, with any body. */
  const fetchPath = (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://t3.test${path}`, init));
  return { dir, handler, request, fetchPath, secretsAsked };
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
  it("uploads other files byte for byte, and opens them through a view link without a session", async () => {
    const { dir, request, fetchPath, secretsAsked } = fixture();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    const uploaded = await fetchPath(
      "/api/artifacts?name=chart.png&title=Chart&folder=img&tags=a,b",
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png,
      },
    );
    expect(uploaded.status).toBe(201);
    const { artifact, content } = await json(uploaded);
    expect(artifact).toMatchObject({
      path: "img/chart.png",
      kind: "other",
      title: "Chart",
      size: 12,
    });
    expect(artifact.tags).toEqual(["a", "b"]);
    expect(content).toBe("");
    expect(new Uint8Array(NodeFS.readFileSync(NodePath.join(dir, "img/chart.png")))).toEqual(png);

    const minted = await request("POST", `/${artifact.id}/view-url`, {});
    expect(minted.status).toBe(200);
    const { url, expiresAt } = await json(minted);
    expect(url).toMatch(/^\/a\/[\w-]+\.[\w-]+$/);
    // One hour by default.
    expect(Math.abs(Date.parse(expiresAt) - Date.now() - 3_600_000)).toBeLessThan(10_000);
    expect(secretsAsked).toContain("lim-artifacts-view-key");

    // A session-less GET (the view route never authenticates).
    const viewed = await fetchPath(url);
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("content-type")).toBe("image/png");
    expect(viewed.headers.get("content-security-policy")).toBe("sandbox");
    expect(viewed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new Uint8Array(await viewed.arrayBuffer())).toEqual(png);
  });

  it("creates HTML with its metadata line, and serves it sandboxed in the app theme", async () => {
    const { dir, request, fetchPath } = fixture();
    const page =
      "<!doctype html><html><head><title>Viz</title></head><body><script>document.cookie</script></body></html>";
    const created = await request("POST", "", { title: "Viz", name: "viz.html", content: page });
    expect(created.status).toBe(201);
    const { artifact, content, items } = await json(created);
    expect(artifact.kind).toBe("html");
    expect(content).toBe(page);
    expect(items).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(dir, "viz.html"), "utf8")).toBe(
      `<!-- t3-artifact id=${artifact.id} title="Viz" -->\n${page}`,
    );
    const { url } = await json(await request("POST", `/${artifact.id}/view-url`, {}));
    const viewed = await fetchPath(url);
    expect(viewed.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups",
    );
    const html = await viewed.text();
    expect(html).toContain('<style id="t3-theme">');
    expect(html).toContain("<script>document.cookie</script>");
    expect(html).not.toContain("t3-artifact");
  });

  it("serves markdown as a standalone page", async () => {
    const { request, fetchPath } = fixture();
    const { artifact } = await json(
      await request("POST", "", { title: "Doc", content: "# Hello\n\n<script>x()</script>\n" }),
    );
    const { url } = await json(await request("POST", `/${artifact.id}/view-url`, {}));
    const viewed = await fetchPath(url);
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(viewed.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    const html = await viewed.text();
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).not.toContain("<script>x()");
  });

  it("refuses tampered, expired, overlong and orphaned view links", async () => {
    const { request, fetchPath } = fixture();
    const { artifact } = await json(await request("POST", "", { title: "Doc" }));
    const { url } = await json(await request("POST", `/${artifact.id}/view-url`, {}));
    expect((await fetchPath(url)).status).toBe(200);
    const [payload, signature] = url.slice("/a/".length).split(".");
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    expect((await fetchPath(`/a/${payload}.${flipped}`)).status).toBe(404);
    expect((await fetchPath("/a/nonsense")).status).toBe(404);
    const now = Math.floor(Date.now() / 1000);
    const signed = (issuedAt: number, expiresAt: number, artifactId = artifact.id) =>
      `/a/${signViewToken(VIEW_KEY, { artifactId, issuedAt, expiresAt })}`;
    const expired = await fetchPath(signed(now - 7200, now - 1));
    expect(expired.status).toBe(410);
    expect(expired.headers.get("content-security-policy")).toContain("sandbox");
    expect((await fetchPath(signed(now, now + 8 * 24 * 3600))).status).toBe(404);
    expect((await fetchPath(signed(now, now + 60, "01ARZ3NDEKTSV4RRFFQ69G5FAV"))).status).toBe(404);
    expect(VIEW_KEY_SECRET_NAME).toBe("lim-artifacts-view-key");
  });

  it("mints links of up to 7 days with the read scope, and no longer", async () => {
    const { request } = fixture();
    const { artifact } = await json(await request("POST", "", { title: "Doc" }));
    const week = await request("POST", `/${artifact.id}/view-url`, {
      expiresInSeconds: 7 * 24 * 3600,
    });
    expect(week.status).toBe(200);
    const longer = await request("POST", `/${artifact.id}/view-url`, {
      expiresInSeconds: 7 * 24 * 3600 + 1,
    });
    expect(longer.status).toBe(400);
    expect((await json(longer)).error.code).toBe("invalid_request");
    expect((await request("POST", "/01ARZ3NDEKTSV4RRFFQ69G5FAV/view-url", {})).status).toBe(404);
    // The read scope is enough to mint (this store hasn't the artifact: 404, not 403).
    const readOnly = fixture({ scopes: [AuthOrchestrationReadScope] });
    expect((await readOnly.request("POST", `/${artifact.id}/view-url`, {})).status).toBe(404);
    const none = fixture({ scopes: [] });
    expect((await none.request("POST", `/${artifact.id}/view-url`, {})).status).toBe(403);
  });

  it("takes an uploaded markdown file's own title and tags, and gives it a new id", async () => {
    const { dir, fetchPath } = fixture();
    const source =
      "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntitle: From Disk\ntags: [spec]\nowner: alder\n---\n- [ ] one\n";
    const response = await fetchPath("/api/artifacts?name=notes.md", {
      method: "POST",
      body: source,
    });
    expect(response.status).toBe(201);
    const { artifact, items } = await json(response);
    expect(artifact).toMatchObject({ title: "From Disk", tags: ["spec"], kind: "md" });
    expect(artifact.id).not.toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(items.map((item: { text: string }) => item.text)).toEqual(["one"]);
    const written = NodeFS.readFileSync(NodePath.join(dir, "notes.md"), "utf8");
    expect(written).toContain(`id: ${artifact.id}`);
    expect(written).toContain("owner: alder");
  });

  it("refuses uploads over the size limit of their kind", async () => {
    const { request, fetchPath } = fixture();
    const textOver = await fetchPath("/api/artifacts?name=big.html", {
      method: "POST",
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(textOver.status).toBe(413);
    expect((await json(textOver)).error.code).toBe("too_large");
    // 20 MB is fine for an other file, which may be up to 50 MB.
    const fits = await fetchPath("/api/artifacts?name=big.bin", {
      method: "POST",
      body: new Uint8Array(20 * 1024 * 1024),
    });
    expect(fits.status).toBe(201);
    const otherOver = await fetchPath("/api/artifacts?name=huge.bin", {
      method: "POST",
      body: new Uint8Array(50 * 1024 * 1024 + 1),
    });
    expect(otherOver.status).toBe(413);
    const listed = await json(await request("GET", ""));
    expect(listed.artifacts.map((entry: { path: string }) => entry.path)).toEqual(["big.bin"]);
  });
});
