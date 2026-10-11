// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LimArtifactActor, LimArtifactChange } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { commitMessage, parseCommitEvents } from "./ArtifactGit.ts";
import { ArtifactStore, ArtifactStoreError } from "./ArtifactStore.ts";

const LEE: LimArtifactActor = { kind: "user", id: "session-1", name: "Lee" };
const ALDER: LimArtifactActor = { kind: "agent", id: "thread-alder", name: "Alder" };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tempStoreDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "artifact-store-"));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return NodePath.join(dir, "artifacts");
};

const openStore = async (dir: string) => {
  const store = await ArtifactStore.open(dir);
  cleanups.unshift(() => store.close());
  return store;
};

const git = (dir: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const commitCount = (dir: string) => Number(git(dir, "rev-list", "--count", "HEAD").trim());

/** Files changed by the newest commit. */
const lastCommitFiles = (dir: string) =>
  git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();

const file = (store: ArtifactStore, path: string) =>
  NodeFS.readFileSync(NodePath.join(store.root, path), "utf8");

/** Bumps a file's mtime so the per-access check notices a same-size edit. */
const touchLater = (absolute: string) => {
  const later = new Date(Date.now() + 5_000);
  NodeFS.utimesSync(absolute, later, later);
};

/** Makes every git write in the store fail until the returned function runs. */
const breakGit = (root: string) => {
  const lock = NodePath.join(root, ".git", "index.lock");
  NodeFS.writeFileSync(lock, "");
  return () => NodeFS.rmSync(lock, { force: true });
};

const rejects = async (promise: Promise<unknown>) =>
  expect(
    await promise.then(
      () => "resolved",
      () => "rejected",
    ),
  ).toBe("rejected");

const expectStoreError = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ArtifactStoreError);
  expect((error as ArtifactStoreError).code).toBe(code);
  return error as ArtifactStoreError;
};

describe("ArtifactStore", () => {
  it("creates a list as a markdown file with front matter in one commit", async () => {
    const dir = tempStoreDir();
    const store = await openStore(dir);
    const before = commitCount(store.root);
    const created = await store.create(
      { title: "Backlog", folder: "t3", tags: ["t3"], content: "- [ ] first\n" },
      LEE,
    );
    expect(created.artifact.path).toBe("t3/backlog.md");
    expect(created.artifact.absolutePath).toBe(NodePath.join(store.root, "t3/backlog.md"));
    expect(created.artifact.createdBy).toEqual(LEE);
    expect(created.items).toHaveLength(1);
    expect(created.items[0]!.id).toMatch(/^[a-z0-9]{2,4}$/);
    const text = file(store, "t3/backlog.md");
    expect(text).toMatch(
      new RegExp(
        `^---\\nid: ${created.artifact.id}\\ntitle: Backlog\\ntags:\\n  - t3\\n---\\n- \\[ \\] first \\^`,
      ),
    );
    expect(commitCount(store.root)).toBe(before + 1);
    expect(git(store.root, "log", "-1", "--format=%an").trim()).toBe("Lee");
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
    // A second artifact with the same title gets its own file.
    const again = await store.create({ title: "Backlog", folder: "t3" }, LEE);
    expect(again.artifact.path).toBe("t3/backlog-2.md");
  });

  it("applies every op type with one commit and one event each", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "List" }, LEE);
    const changes: LimArtifactChange[] = [];
    store.subscribe((change) => changes.push(change));
    const commits = () => commitCount(store.root);

    const added = await store.applyOps(artifact.id, [{ op: "add", text: "one" }], ALDER);
    const one = added.itemIds[0]!;
    const two = (await store.applyOps(artifact.id, [{ op: "add", text: "two", at: "top" }], LEE))
      .itemIds[0]!;
    const steps = [
      { op: "edit", id: one, text: "one, edited" },
      { op: "check", id: one },
      { op: "uncheck", id: one },
      { op: "move", id: two, to: `after:${one}` },
      { op: "remove", id: two },
    ] as const;
    for (const step of steps) {
      const count = commits();
      await store.applyOps(artifact.id, [step], ALDER);
      expect(commits()).toBe(count + 1);
    }
    expect(changes.map((change) => change.action)).toEqual([
      "add",
      "add",
      "edit",
      "check",
      "uncheck",
      "move",
      "remove",
    ]);
    expect(changes.every((change) => change.itemId !== null)).toBe(true);
    const read = await store.read(artifact.id);
    expect(read.items.map((item) => [item.text, item.checked])).toEqual([["one, edited", false]]);
    expect(read.items[0]!.lastChange).toMatchObject({ action: "uncheck", actor: ALDER });
    expect(git(store.root, "log", "-1", "--format=%an%n%B")).toContain("Alder");
    expect(git(store.root, "log", "-1", "--format=%B")).toContain(`T3-Item: ${two}`);
  });

  it("applies 20 concurrent ops to one list, all of them, consistently", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Busy" }, LEE);
    const before = commitCount(store.root);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.applyOps(
          artifact.id,
          [{ op: "add", text: `item ${index}` }],
          index % 2 ? LEE : ALDER,
        ),
      ),
    );
    const read = await store.read(artifact.id);
    expect(read.items).toHaveLength(20);
    expect(new Set(read.items.map((item) => item.id)).size).toBe(20);
    expect(new Set(results.map((result) => result.itemIds[0])).size).toBe(20);
    expect(read.items.map((item) => item.text).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `item ${index}`).sort(),
    );
    expect(commitCount(store.root)).toBe(before + 20);
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
    // Check and remove concurrently too.
    await Promise.all(
      read.items.map((item, index) =>
        store.applyOps(
          artifact.id,
          [index % 2 ? { op: "check", id: item.id! } : { op: "remove", id: item.id! }],
          ALDER,
        ),
      ),
    );
    const after = await store.read(artifact.id);
    expect(after.items).toHaveLength(10);
    expect(after.items.every((item) => item.checked)).toBe(true);
  });

  it("answers an op on a removed item with not-found and the current revision", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "L", content: "- [ ] a\n- [ ] b\n" }, LEE);
    const [a] = (await store.read(artifact.id)).items;
    await store.applyOps(artifact.id, [{ op: "remove", id: a!.id! }], LEE);
    const current = (await store.read(artifact.id)).artifact.revision;
    const count = commitCount(store.root);
    const error = await expectStoreError(
      store.applyOps(artifact.id, [{ op: "check", id: a!.id! }], ALDER),
      "item_not_found",
    );
    expect(error.currentRevision).toBe(current);
    expect(commitCount(store.root)).toBe(count);
  });

  it("commits a hand edit as external before serving it", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Hand", content: "- [ ] a\n" }, LEE);
    const absolute = NodePath.join(store.root, artifact.path);
    NodeFS.appendFileSync(absolute, "- [ ] typed in vim\n");
    const read = await store.read(artifact.id);
    expect(read.items.map((item) => item.text)).toEqual(["a", "typed in vim"]);
    expect(read.items[1]!.id).toBeNull();
    expect(git(store.root, "log", "-1", "--format=%an|%s").trim()).toBe(
      `External edit|External edit: ${artifact.path}`,
    );
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
    expect(read.artifact.revision).not.toBe(artifact.revision);
    // The next T3 write gives the new item an id.
    const assigned = await store.applyOps(artifact.id, [], LEE);
    expect(assigned.items.every((item) => item.id !== null)).toBe(true);
  });

  it("picks up a same-size edit by mtime, and keeps the id when front matter is deleted", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Same", content: "- [ ] aaa\n" }, LEE);
    const absolute = NodePath.join(store.root, artifact.path);
    NodeFS.writeFileSync(absolute, file(store, artifact.path).replace("aaa", "bbb"));
    touchLater(absolute);
    expect((await store.read(artifact.id)).items[0]!.text).toBe("bbb");
    NodeFS.writeFileSync(absolute, "- [ ] no front matter now\n");
    const read = await store.read(artifact.id);
    expect(read.artifact.id).toBe(artifact.id);
    expect(file(store, artifact.path)).toContain(`id: ${artifact.id}`);
  });

  it("follows a file moved outside T3 and drops one removed outside T3", async () => {
    const store = await openStore(tempStoreDir());
    const moved = await store.create({ title: "Mover" }, LEE);
    const gone = await store.create({ title: "Gone" }, LEE);
    await store.attach(gone.artifact.id, "thread-a", "write", LEE);
    NodeFS.mkdirSync(NodePath.join(store.root, "elsewhere"));
    NodeFS.renameSync(
      NodePath.join(store.root, moved.artifact.path),
      NodePath.join(store.root, "elsewhere/mover.md"),
    );
    NodeFS.rmSync(NodePath.join(store.root, gone.artifact.path));
    expect((await store.read(moved.artifact.id)).artifact.path).toBe("elsewhere/mover.md");
    await expectStoreError(store.read(gone.artifact.id), "not_found");
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
    expect(file(store, ".t3-meta/links.json")).not.toContain(gone.artifact.id);
  });

  it("writes .t3-meta/links.json in the same commit as every attach and detach", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Linked" }, LEE);
    await store.attach(artifact.id, "thread-claude", "write", LEE);
    expect(lastCommitFiles(store.root)).toEqual([".t3-meta/links.json"]);
    expect(git(store.root, "show", "HEAD", "--", ".t3-meta/links.json")).toContain(
      '+          "threadId": "thread-claude"',
    );
    await store.attach(artifact.id, "thread-codex", "read", LEE);
    expect(lastCommitFiles(store.root)).toEqual([".t3-meta/links.json"]);
    const summary = await store.detach(artifact.id, "thread-claude", LEE);
    expect(summary.links.map((link) => link.threadId)).toEqual(["thread-codex"]);
    expect(lastCommitFiles(store.root)).toEqual([".t3-meta/links.json"]);
    expect(git(store.root, "show", "HEAD", "--", ".t3-meta/links.json")).toContain(
      '-          "threadId": "thread-claude"',
    );
    // Create with attach links in the create commit itself.
    await store.create({ title: "Born linked", attach: [{ threadId: "thread-x" }] }, LEE);
    expect(lastCommitFiles(store.root)).toEqual([".t3-meta/links.json", "born-linked.md"]);
    await expectStoreError(store.detach(artifact.id, "thread-nope", LEE), "not_found");
    await expectStoreError(store.attach(artifact.id, "../bad", "write", LEE), "invalid_request");
  });

  it("lists by thread, tag, folder, kind and text", async () => {
    const store = await openStore(tempStoreDir());
    const a = await store.create(
      { title: "Alpha", folder: "t3", tags: ["x"], content: "find me" },
      LEE,
    );
    await store.create({ title: "Beta", folder: "research", tags: ["y"] }, LEE);
    await store.attach(a.artifact.id, "thread-1", "write", LEE);
    const titles = async (filter: Parameters<ArtifactStore["list"]>[0]) =>
      (await store.list(filter)).map((artifact) => artifact.title).sort();
    expect(await titles({})).toEqual(["Alpha", "Beta"]);
    expect(await titles({ threadId: "thread-1" })).toEqual(["Alpha"]);
    expect(await titles({ tag: "y" })).toEqual(["Beta"]);
    expect(await titles({ folder: "research" })).toEqual(["Beta"]);
    expect(await titles({ kind: "html" })).toEqual([]);
    expect(await titles({ query: "find" })).toEqual(["Alpha"]);
    expect(await titles({ query: "%" })).toEqual([]);
  });

  it("refuses paths that leave the store", async () => {
    const store = await openStore(tempStoreDir());
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "artifact-outside-"));
    cleanups.push(() => NodeFS.rmSync(outside, { recursive: true, force: true }));
    NodeFS.symlinkSync(outside, NodePath.join(store.root, "escape"));
    for (const input of [
      { title: "x", folder: "../up" },
      { title: "x", folder: "/tmp" },
      { title: "x", folder: ".git/hooks" },
      { title: "x", folder: "escape" },
      { title: "x", name: "../x.md" },
      { title: "x", folder: "escape", name: "x.html" },
      { title: "", folder: "escape", name: "x.png", bytes: new Uint8Array(1) },
    ]) {
      await expect(store.create(input, LEE)).rejects.toThrow();
    }
    expect(NodeFS.readdirSync(outside)).toEqual([]);
    await expectStoreError(store.read("not-an-id"), "not_found");
  });

  it("rebuilds the list, its links and items after the index is deleted", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create(
      { title: "Backlog", content: "- [ ] a\n- [x] b\n" },
      LEE,
    );
    await first.attach(artifact.id, "thread-claude", "write", LEE);
    await first.attach(artifact.id, "thread-codex", "read", ALDER);
    const [a] = (await first.read(artifact.id)).items;
    await first.applyOps(artifact.id, [{ op: "check", id: a!.id! }], ALDER);
    const before = await first.read(artifact.id);
    first.close();

    NodeFS.rmSync(NodePath.join(dir, ".t3", "index.sqlite"));
    const commits = commitCount(dir);
    const second = await openStore(dir);
    const after = await second.read(artifact.id);
    // Times come back from the commit log, which keeps whole seconds.
    const seconds = (iso: string) => iso.slice(0, 19);
    expect(after.artifact).toEqual({
      ...before.artifact,
      createdAt: after.artifact.createdAt,
      updatedAt: after.artifact.updatedAt,
    });
    expect(seconds(after.artifact.createdAt)).toBe(seconds(before.artifact.createdAt));
    expect(
      after.artifact.links.map((link) => [link.threadId, link.access, link.linkedBy.name]),
    ).toEqual([
      ["thread-claude", "write", "Lee"],
      ["thread-codex", "read", "Alder"],
    ]);
    expect(after.items.map(({ id, checked, text }) => ({ id, checked, text }))).toEqual(
      before.items.map(({ id, checked, text }) => ({ id, checked, text })),
    );
    expect(after.items[0]!.lastChange).toMatchObject({ action: "check", actor: ALDER });
    expect(await second.list({ threadId: "thread-codex" })).toHaveLength(1);
    // Rebuilding commits nothing.
    expect(commitCount(dir)).toBe(commits);
  });

  it("rebuilds createdAt from the time the artifact was created, not when git ran", async () => {
    const dir = tempStoreDir();
    // A clock far from the wall clock: the commit's author date must come from it.
    const first = await ArtifactStore.open(dir, {
      now: () => new Date("2020-01-02T03:04:05.999Z"),
    });
    const { artifact } = await first.create({ title: "Dated" }, LEE);
    const root = first.root;
    first.close();
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const store = await openStore(dir);
    expect((await store.read(artifact.id)).artifact.createdAt).toBe("2020-01-02T03:04:05.000Z");
  });

  it("checks a guard inside the change's turn, against the links as they are then", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create(
      { title: "Guarded", attach: [{ threadId: "thread-a" }] },
      LEE,
    );
    const canWrite =
      (threadId: string) => (summary: { links: ReadonlyArray<{ threadId: string }> }) => {
        if (!summary.links.some((link) => link.threadId === threadId)) {
          throw new ArtifactStoreError("forbidden", "no write link");
        }
      };
    const commits = commitCount(store.root);
    // Queued behind the detach: the guard sees the link already gone.
    const detached = store.detach(artifact.id, "thread-a", LEE);
    const patched = store.applyOps(
      artifact.id,
      [{ op: "add", text: "late" }],
      ALDER,
      canWrite("thread-a"),
    );
    await detached;
    await expectStoreError(patched, "forbidden");
    expect((await store.read(artifact.id)).items).toEqual([]);
    expect(commitCount(store.root)).toBe(commits + 1);
  });

  it("opens with an HTML file whose title has an out-of-range numeric entity", async () => {
    const dir = tempStoreDir();
    (await ArtifactStore.open(dir)).close();
    NodeFS.writeFileSync(
      NodePath.join(dir, "odd.html"),
      "<html><head><title>Odd &#999999999;</title></head><body></body></html>\n",
    );
    const store = await openStore(dir);
    const listed = await store.list();
    expect(listed.find((entry) => entry.path === "odd.html")?.title).toBe("Odd \uFFFD");
  });

  it("adopts new files and commits edits made while the server was down", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Existing" }, LEE);
    first.close();
    NodeFS.writeFileSync(NodePath.join(dir, "dropped.md"), "# Dropped in\n- [ ] x\n");
    NodeFS.appendFileSync(NodePath.join(dir, artifact.path), "- [ ] offline edit\n");
    const second = await openStore(dir);
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
    const listed = await second.list();
    const dropped = listed.find((entry) => entry.path === "dropped.md");
    expect(dropped?.title).toBe("Dropped in");
    expect(file(second, "dropped.md")).toMatch(new RegExp(`^---\\nid: ${dropped!.id}\\n`));
    expect((await second.read(artifact.id)).items.map((item) => item.text)).toEqual([
      "offline edit",
    ]);
    expect(git(dir, "log", "-1", "--format=%an").trim()).toBe("External edit");
  });

  it.each(["aa-copy.md", "zz-copy.md"])(
    "gives a copied file (%s) its own id, and the original keeps its id and links",
    async (copyName) => {
      const dir = tempStoreDir();
      const first = await ArtifactStore.open(dir);
      const { artifact } = await first.create({ title: "Original" }, LEE);
      await first.attach(artifact.id, "thread-1", "write", LEE);
      first.close();
      NodeFS.copyFileSync(NodePath.join(dir, artifact.path), NodePath.join(dir, copyName));
      const second = await openStore(dir);
      const listed = await second.list();
      expect(listed).toHaveLength(2);
      expect(new Set(listed.map((entry) => entry.id)).size).toBe(2);
      const original = listed.find((entry) => entry.path === artifact.path)!;
      expect(original.id).toBe(artifact.id);
      expect(original.links.map((link) => link.threadId)).toEqual(["thread-1"]);
      expect(file(second, copyName)).not.toContain(artifact.id);
    },
  );

  it("stops serving a file grown past 10 MB outside T3, keeping its links until it shrinks", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows", content: "- [ ] a\n" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const absolute = NodePath.join(first.root, artifact.path);
    const original = NodeFS.readFileSync(absolute, "utf8");
    const commits = commitCount(first.root);
    NodeFS.appendFileSync(absolute, "x".repeat(10 * 1024 * 1024));
    await expectStoreError(first.read(artifact.id), "too_large");
    expect(await first.list()).toEqual([]);
    expect(commitCount(first.root)).toBe(commits);
    expect(NodeFS.existsSync(absolute)).toBe(true);
    // A restart while it's oversized keeps it too.
    first.close();
    const store = await openStore(dir);
    expect(file(store, ".t3-meta/links.json")).toContain("thread-a");
    NodeFS.writeFileSync(absolute, `${original}- [ ] b\n`);
    const back = await store.read(artifact.id);
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    expect(back.items.map((item) => item.text)).toEqual(["a", "b"]);
  });

  it("keeps an oversized artifact's links when it also moved outside T3", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const moved = NodePath.join(root, "moved.md");
    NodeFS.renameSync(NodePath.join(root, artifact.path), moved);
    const original = NodeFS.readFileSync(moved, "utf8");
    NodeFS.appendFileSync(moved, "x".repeat(10 * 1024 * 1024));
    const store = await openStore(dir);
    expect(file(store, ".t3-meta/links.json")).toContain("thread-a");
    NodeFS.writeFileSync(moved, original);
    const back = await store.read(artifact.id);
    expect(back.artifact.path).toBe("moved.md");
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
  });

  it("keeps a moved oversized artifact's id when a new file takes its old path", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const moved = NodePath.join(root, "moved.md");
    NodeFS.renameSync(NodePath.join(root, artifact.path), moved);
    const original = NodeFS.readFileSync(moved, "utf8");
    NodeFS.appendFileSync(moved, "x".repeat(10 * 1024 * 1024));
    NodeFS.writeFileSync(NodePath.join(root, artifact.path), "# Newcomer\n");
    const store = await openStore(dir);
    const newcomer = (await store.list()).find((row) => row.path === artifact.path);
    expect(newcomer?.id).not.toBe(artifact.id);
    expect(newcomer?.links).toEqual([]);
    await expectStoreError(store.read(artifact.id), "too_large");
    NodeFS.writeFileSync(moved, original);
    const back = await store.read(artifact.id);
    expect(back.artifact.path).toBe("moved.md");
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
  });

  it("keeps an oversized artifact's links through an index rebuild", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const absolute = NodePath.join(root, artifact.path);
    const original = NodeFS.readFileSync(absolute, "utf8");
    NodeFS.appendFileSync(absolute, "x".repeat(10 * 1024 * 1024));
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const store = await openStore(dir);
    expect(file(store, ".t3-meta/links.json")).toContain("thread-a");
    await expectStoreError(store.read(artifact.id), "too_large");
    NodeFS.writeFileSync(absolute, original);
    const back = await store.read(artifact.id);
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    expect(back.artifact.createdBy?.name).toBe("Lee");
  });

  it("retries a moved or removed file's commit on the next access after the scan's commit fails", async () => {
    const store = await openStore(tempStoreDir());
    const moved = (await store.create({ title: "Mover" }, LEE)).artifact;
    const gone = (await store.create({ title: "Gone" }, LEE)).artifact;
    await store.attach(gone.id, "thread-a", "write", LEE);
    NodeFS.renameSync(NodePath.join(store.root, moved.path), NodePath.join(store.root, "moved.md"));
    NodeFS.rmSync(NodePath.join(store.root, gone.path));
    const fixGit = breakGit(store.root);
    await rejects(store.read(moved.id));
    fixGit();
    expect((await store.read(moved.id)).artifact.path).toBe("moved.md");
    const log = git(store.root, "log", "-1", "--format=%B");
    expect(log).toContain("T3-Action: moved");
    expect(log).toContain("T3-Action: removed");
    expect(file(store, ".t3-meta/links.json")).not.toContain(gone.id);
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("rebuilds again on the next open when a rebuild's commit fails", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Linked" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    // An edit made while down makes the rebuild commit.
    NodeFS.appendFileSync(NodePath.join(root, artifact.path), "- [ ] while down\n");
    const fixGit = breakGit(root);
    await rejects(ArtifactStore.open(dir));
    fixGit();
    const store = await openStore(dir);
    expect((await store.read(artifact.id)).artifact.links.map((link) => link.threadId)).toEqual([
      "thread-a",
    ]);
  });

  it("rolls back and retries a swap whose scan commit fails", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const a = (await first.create({ title: "Alpha" }, LEE)).artifact;
    const b = (await first.create({ title: "Beta" }, LEE)).artifact;
    await first.attach(a.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const at = (path: string) => NodePath.join(root, path);
    NodeFS.renameSync(at(a.path), at("swap.tmp"));
    NodeFS.renameSync(at(b.path), at(a.path));
    NodeFS.renameSync(at("swap.tmp"), at(b.path));
    const fixGit = breakGit(root);
    await rejects(ArtifactStore.open(dir));
    fixGit();
    const store = await openStore(dir);
    expect((await store.read(a.id)).artifact.path).toBe(b.path);
    expect((await store.read(a.id)).artifact.links.map((link) => link.threadId)).toEqual([
      "thread-a",
    ]);
    expect(git(store.root, "log", "-1", "--format=%B")).toContain("T3-Action: moved");
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("serves the body of the file the row describes when an editor replaces it after the check", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Swap", content: "- [ ] a\n" }, LEE);
    const absolute = NodePath.join(store.root, artifact.path);
    const internals = store as unknown as { current: (id: string) => Promise<unknown> };
    const current = internals.current.bind(store);
    let replaced = false;
    vi.spyOn(internals, "current").mockImplementation(async (id) => {
      const row = await current(id);
      if (!replaced) {
        replaced = true;
        const next = `${NodeFS.readFileSync(absolute, "utf8")}- [ ] replaced\n`;
        NodeFS.writeFileSync(`${absolute}.tmp`, next);
        NodeFS.renameSync(`${absolute}.tmp`, absolute);
        touchLater(absolute);
      }
      return row;
    });
    const result = await store.read(artifact.id);
    expect(result.items.map((item) => item.text)).toEqual(["a", "replaced"]);
    expect(result.artifact.revision).not.toBe(artifact.revision);
    expect(git(store.root, "log", "-1", "--format=%B")).toContain("T3-Action: external");
  });

  it("names every op's item even when the ops leave the file unchanged", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact, items } = await store.create({ title: "Noop", content: "- [x] a\n" }, LEE);
    const id = items[0]!.id!;
    const commits = commitCount(store.root);
    const result = await store.applyOps(
      artifact.id,
      [
        { op: "check", id },
        { op: "uncheck", id },
        { op: "check", id },
      ],
      LEE,
    );
    expect(result.itemIds).toEqual([id, id, id]);
    expect(commitCount(store.root)).toBe(commits);
  });

  it("refuses markdown over 10 MB", async () => {
    const store = await openStore(tempStoreDir());
    await expectStoreError(
      store.create({ title: "Huge", content: "x".repeat(10 * 1024 * 1024 + 1) }, LEE),
      "too_large",
    );
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("undoes an op whose commit fails, so a retried add applies once", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Retry", content: "- [ ] a\n" }, LEE);
    const before = file(store, artifact.path);
    const commits = commitCount(store.root);
    const fixGit = breakGit(store.root);
    await rejects(store.applyOps(artifact.id, [{ op: "add", text: "b" }], LEE));
    fixGit();
    expect(file(store, artifact.path)).toBe(before);
    expect((await store.read(artifact.id)).items.map((item) => item.text)).toEqual(["a"]);
    await store.applyOps(artifact.id, [{ op: "add", text: "b" }], LEE);
    expect((await store.read(artifact.id)).items.map((item) => item.text)).toEqual(["a", "b"]);
    expect(commitCount(store.root)).toBe(commits + 1);
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("undoes a create, attach or detach whose commit fails", async () => {
    const store = await openStore(tempStoreDir());
    let fixGit = breakGit(store.root);
    await rejects(store.create({ title: "Never", attach: [{ threadId: "thread-a" }] }, LEE));
    fixGit();
    expect(await store.list()).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(store.root, "never.md"))).toBe(false);

    const { artifact } = await store.create({ title: "Linked" }, LEE);
    fixGit = breakGit(store.root);
    await rejects(store.attach(artifact.id, "thread-a", "write", LEE));
    fixGit();
    expect((await store.read(artifact.id)).artifact.links).toEqual([]);
    // The retry isn't skipped as already attached: it commits links.json.
    await store.attach(artifact.id, "thread-a", "write", LEE);
    expect(lastCommitFiles(store.root)).toEqual([".t3-meta/links.json"]);

    fixGit = breakGit(store.root);
    await rejects(store.detach(artifact.id, "thread-a", LEE));
    fixGit();
    expect((await store.read(artifact.id)).artifact.links.map((link) => link.threadId)).toEqual([
      "thread-a",
    ]);
    expect(file(store, ".t3-meta/links.json")).toContain("thread-a");
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("retries an outside edit's commit on the next access after it fails", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Hand", content: "- [ ] a\n" }, LEE);
    const absolute = NodePath.join(store.root, artifact.path);
    NodeFS.appendFileSync(absolute, "- [ ] by hand\n");
    const fixGit = breakGit(store.root);
    await rejects(store.read(artifact.id));
    fixGit();
    await store.read(artifact.id);
    expect(git(store.root, "log", "-1", "--format=%B")).toContain("T3-Action: external");
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("keeps an outside edit's event in git when the outside writer committed it", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Self", content: "- [ ] a\n" }, LEE);
    NodeFS.appendFileSync(NodePath.join(first.root, artifact.path), "- [ ] committed outside\n");
    git(first.root, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "outside");
    await first.read(artifact.id);
    expect(git(first.root, "log", "-1", "--format=%B")).toContain("T3-Action: external");
    const root = first.root;
    first.close();
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const second = await openStore(dir);
    const changes: string[] = [];
    // The rebuilt index has the event: the artifact's history includes it.
    expect(git(second.root, "log", "--format=%B")).toContain("T3-Action: external");
    for (const line of git(second.root, "log", "--format=%B").split("\n")) {
      if (line.startsWith("T3-Action: ")) changes.push(line.slice("T3-Action: ".length));
    }
    expect(changes).toContain("external");
  });

  it("doesn't overwrite an outside edit that lands while an op is being applied", async () => {
    const store = await openStore(tempStoreDir());
    const { artifact } = await store.create({ title: "Race", content: "- [ ] a\n" }, LEE);
    const absolute = NodePath.join(store.root, artifact.path);
    const readBody = (store as unknown as { readBody: (row: unknown) => unknown }).readBody.bind(
      store,
    );
    let raced = false;
    vi.spyOn(
      store as unknown as { readBody: (row: unknown) => unknown },
      "readBody",
    ).mockImplementation((row) => {
      const result = readBody(row);
      if (!raced) {
        raced = true;
        NodeFS.appendFileSync(absolute, "- [ ] outside ^zz\n");
        touchLater(absolute);
      }
      return result;
    });
    await store.applyOps(artifact.id, [{ op: "add", text: "from T3" }], LEE);
    const texts = (await store.read(artifact.id)).items.map((item) => item.text);
    expect(texts).toEqual(["a", "outside", "from T3"]);
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("keeps ids, links and creators when two files swap names outside T3", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const a = (await first.create({ title: "Alpha" }, LEE)).artifact;
    const b = (await first.create({ title: "Beta" }, ALDER)).artifact;
    await first.attach(a.id, "thread-a", "write", LEE);
    await first.attach(b.id, "thread-b", "write", ALDER);
    const root = first.root;
    first.close();
    const at = (path: string) => NodePath.join(root, path);
    NodeFS.renameSync(at(a.path), at("swap.tmp"));
    NodeFS.renameSync(at(b.path), at(a.path));
    NodeFS.renameSync(at("swap.tmp"), at(b.path));
    const store = await openStore(dir);
    const alpha = (await store.read(a.id)).artifact;
    const beta = (await store.read(b.id)).artifact;
    expect([alpha.path, beta.path]).toEqual([b.path, a.path]);
    expect(alpha.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    expect(beta.links.map((link) => link.threadId)).toEqual(["thread-b"]);
    expect([alpha.createdBy?.name, beta.createdBy?.name]).toEqual(["Lee", "Alder"]);
    expect(file(store, ".t3-meta/links.json")).toContain("thread-b");
  });

  it("keeps a moved file's id when a new file takes its old path", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const moved = (await first.create({ title: "Mover" }, LEE)).artifact;
    await first.attach(moved.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    NodeFS.renameSync(NodePath.join(root, moved.path), NodePath.join(root, "moved.md"));
    NodeFS.writeFileSync(NodePath.join(root, moved.path), "# Newcomer\n");
    const store = await openStore(dir);
    const after = (await store.read(moved.id)).artifact;
    expect(after.path).toBe("moved.md");
    expect(after.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    const newcomer = (await store.list()).find((row) => row.path === moved.path);
    expect(newcomer?.id).not.toBe(moved.id);
  });

  it("opens with a hand-broken links.json, restoring the entries that are well formed", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const good = (await first.create({ title: "Good" }, LEE)).artifact;
    const bad = (await first.create({ title: "Bad" }, LEE)).artifact;
    await first.attach(good.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const linksPath = NodePath.join(root, ".t3-meta", "links.json");
    const links = JSON.parse(NodeFS.readFileSync(linksPath, "utf8"));
    links.artifacts[bad.id] = { path: 5, links: "nope" };
    links.artifacts[good.id].links.push({ threadId: 7 });
    NodeFS.writeFileSync(linksPath, JSON.stringify(links));
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const store = await openStore(dir);
    expect((await store.read(good.id)).artifact.links.map((link) => link.threadId)).toEqual([
      "thread-a",
    ]);
    expect((await store.read(bad.id)).artifact.links).toEqual([]);
  });
});

describe("ArtifactStore content types", () => {
  const HTML =
    "<!doctype html><html><head><title>Chart &amp; Notes</title></head><body>hi</body></html>";

  it("creates HTML with a first-line metadata comment, and rebuilds it from the file", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const before = commitCount(first.root);
    const created = await first.create(
      { title: 'Q3 "draft" -->', name: "q3.html", content: HTML, tags: ["viz", "q3"] },
      LEE,
    );
    expect(created.artifact).toMatchObject({ kind: "html", path: "q3.html" });
    expect(created.content).toBe(HTML);
    const text = file(first, "q3.html");
    expect(text.split("\n")[0]).toBe(
      `<!-- t3-artifact id=${created.artifact.id} title="Q3 &quot;draft&quot; --&gt;" tags="viz, q3" -->`,
    );
    expect(commitCount(first.root)).toBe(before + 1);
    expect((await first.read(created.artifact.id)).content).toBe(HTML);
    expect((await first.list({ kind: "html", query: "hi" })).map((a) => a.id)).toEqual([
      created.artifact.id,
    ]);
    const root = first.root;
    first.close();
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const rebuilt = await openStore(dir);
    const [back] = await rebuilt.list();
    expect(back).toMatchObject({
      id: created.artifact.id,
      title: 'Q3 "draft" -->',
      tags: ["q3", "viz"],
      kind: "html",
    });
  });

  it("adopts an HTML file dropped into the store, titled from its <title>", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    first.close();
    NodeFS.writeFileSync(NodePath.join(dir, "dropped.html"), HTML);
    const store = await openStore(dir);
    const [adopted] = await store.list();
    expect(adopted).toMatchObject({ title: "Chart & Notes", kind: "html", path: "dropped.html" });
    expect(file(store, "dropped.html")).toBe(
      `<!-- t3-artifact id=${adopted!.id} title="Chart &amp; Notes" -->\n${HTML}`,
    );
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("uploads other files byte for byte, keeping their title and tags in links.json", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const created = await first.create(
      { title: "", name: "scan.pdf", bytes, tags: ["receipts"] },
      LEE,
    );
    expect(created.artifact).toMatchObject({ kind: "other", title: "scan", size: bytes.length });
    expect(created.content).toBe("");
    expect(new Uint8Array(NodeFS.readFileSync(NodePath.join(first.root, "scan.pdf")))).toEqual(
      bytes,
    );
    expect(lastCommitFiles(first.root)).toEqual([".t3-meta/links.json", "scan.pdf"]);
    expect((await first.view(created.artifact.id)).content).toEqual(Buffer.from(bytes));
    const csv = await first.create({ title: "Data", name: "data.csv", content: "a,b\n1,2\n" }, LEE);
    expect(csv.content).toBe("a,b\n1,2\n");
    expect((await first.read(csv.artifact.id)).content).toBe("a,b\n1,2\n");
    await first.attach(created.artifact.id, "thread-a", "read", LEE);
    const root = first.root;
    first.close();
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const rebuilt = await openStore(dir);
    const back = (await rebuilt.list()).find((entry) => entry.path === "scan.pdf");
    expect(back).toMatchObject({ id: created.artifact.id, title: "scan", tags: ["receipts"] });
    expect(back?.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    expect((await rebuilt.list()).find((entry) => entry.path === "data.csv")?.id).toBe(
      csv.artifact.id,
    );
  });

  it("keeps an oversized other file's id, title, tags and links through an index rebuild", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create(
      { title: "Scan", name: "scan.bin", tags: ["receipts"], bytes: Uint8Array.from([1, 2, 3]) },
      LEE,
    );
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const absolute = NodePath.join(root, artifact.path);
    const original = NodeFS.readFileSync(absolute);
    NodeFS.truncateSync(absolute, 50 * 1024 * 1024 + 1);
    NodeFS.rmSync(NodePath.join(root, ".t3", "index.sqlite"));
    const store = await openStore(dir);
    await expectStoreError(store.read(artifact.id), "too_large");
    expect(file(store, ".t3-meta/links.json")).toContain("thread-a");
    NodeFS.writeFileSync(absolute, original);
    const back = (await store.list()).find((entry) => entry.path === artifact.path);
    expect(back).toMatchObject({ id: artifact.id, title: "Scan", tags: ["receipts"] });
    expect(back?.links.map((link) => link.threadId)).toEqual(["thread-a"]);
  });

  it("sends a text file over 1 MB through a view link, not inline", async () => {
    const store = await openStore(tempStoreDir());
    const small = await store.create({ title: "Small", name: "small.csv", content: "a,b\n" }, LEE);
    expect((await store.read(small.artifact.id)).content).toBe("a,b\n");
    const big = await store.create(
      { title: "Big", name: "big.csv", content: `${"a,b\n".repeat(300 * 1024)}` },
      LEE,
    );
    expect(big.artifact.size).toBeGreaterThan(1024 * 1024);
    expect(big.content).toBe("");
    expect((await store.read(big.artifact.id)).content).toBe("");
  });

  it("follows an other file moved outside T3 by its content", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create(
      { title: "Logo", name: "logo.png", bytes: Uint8Array.from([1, 2, 3]) },
      LEE,
    );
    await first.attach(artifact.id, "thread-a", "write", LEE);
    first.close();
    NodeFS.mkdirSync(NodePath.join(dir, "img"));
    NodeFS.renameSync(NodePath.join(dir, "logo.png"), NodePath.join(dir, "img", "logo.png"));
    const store = await openStore(dir);
    const [moved] = await store.list();
    expect(moved).toMatchObject({ id: artifact.id, path: "img/logo.png", title: "Logo" });
    expect(moved?.links.map((link) => link.threadId)).toEqual(["thread-a"]);
    expect(git(dir, "log", "-1", "--format=%B")).toContain("T3-Action: moved");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("limits markdown and HTML to 10 MB and other files to 50 MB", async () => {
    const store = await openStore(tempStoreDir());
    const tenMb = 10 * 1024 * 1024;
    await expectStoreError(
      store.create({ title: "Huge", name: "huge.html", content: "x".repeat(tenMb + 1) }, LEE),
      "too_large",
    );
    const twenty = await store.create(
      { title: "", name: "big.bin", bytes: new Uint8Array(2 * tenMb) },
      LEE,
    );
    expect(twenty.artifact.size).toBe(2 * tenMb);
    // Read back through the per-access check: 20 MB isn't "too large" for an other file.
    expect((await store.read(twenty.artifact.id)).artifact.id).toBe(twenty.artifact.id);
    await expectStoreError(
      store.create({ title: "", name: "huge.bin", bytes: new Uint8Array(5 * tenMb + 1) }, LEE),
      "too_large",
    );
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });

  it("adopts an other file of 20 MB dropped in, and keeps one grown past 50 MB with its links", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create(
      { title: "", name: "grows.bin", bytes: new Uint8Array(10) },
      LEE,
    );
    await first.attach(artifact.id, "thread-a", "write", LEE);
    first.close();
    NodeFS.writeFileSync(NodePath.join(dir, "dropped.bin"), new Uint8Array(20 * 1024 * 1024));
    NodeFS.writeFileSync(NodePath.join(dir, "grows.bin"), new Uint8Array(50 * 1024 * 1024 + 1));
    const store = await openStore(dir);
    expect((await store.list()).map((entry) => entry.path)).toEqual(["dropped.bin"]);
    await expectStoreError(store.read(artifact.id), "too_large");
    NodeFS.writeFileSync(NodePath.join(dir, "grows.bin"), new Uint8Array(20));
    const back = await store.read(artifact.id);
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
  });

  it("keeps an oversized artifact's id when a normal-size copy of it appears (PR 1 deferred)", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows", content: "- [ ] a\n" }, LEE);
    await first.attach(artifact.id, "thread-a", "write", LEE);
    const root = first.root;
    first.close();
    const absolute = NodePath.join(root, artifact.path);
    const original = NodeFS.readFileSync(absolute, "utf8");
    NodeFS.appendFileSync(absolute, "x".repeat(10 * 1024 * 1024));
    // A normal-size copy carrying the same id, as if trimmed from the big file.
    NodeFS.writeFileSync(NodePath.join(root, "copy.md"), original);
    const store = await openStore(dir);
    const copy = (await store.list()).find((entry) => entry.path === "copy.md");
    expect(copy?.id).not.toBe(artifact.id);
    expect(copy?.links).toEqual([]);
    expect(file(store, "copy.md")).not.toContain(artifact.id);
    await expectStoreError(store.read(artifact.id), "too_large");
    NodeFS.writeFileSync(absolute, original);
    const back = await store.read(artifact.id);
    expect(back.artifact.path).toBe(artifact.path);
    expect(back.artifact.links.map((link) => link.threadId)).toEqual(["thread-a"]);
  });

  it.each(["on the next read", "on a restart"])(
    "commits a move made while oversized as one move once the file shrinks, %s (PR 1 deferred)",
    async (when) => {
      const dir = tempStoreDir();
      const first = await ArtifactStore.open(dir);
      const { artifact } = await first.create({ title: "Grows" }, LEE);
      await first.attach(artifact.id, "thread-a", "write", LEE);
      const root = first.root;
      first.close();
      const moved = NodePath.join(root, "moved.md");
      NodeFS.renameSync(NodePath.join(root, artifact.path), moved);
      const original = NodeFS.readFileSync(moved, "utf8");
      NodeFS.appendFileSync(moved, "x".repeat(10 * 1024 * 1024));
      let store = await openStore(dir);
      await expectStoreError(store.read(artifact.id), "too_large");
      NodeFS.writeFileSync(moved, original);
      if (when === "on a restart") {
        store.close();
        store = await openStore(dir);
      }
      const back = await store.read(artifact.id);
      expect(back.artifact.path).toBe("moved.md");
      expect(git(root, "status", "--porcelain").trim()).toBe("");
      expect(git(root, "log", "-1", "--format=%B")).toContain("T3-Action: moved");
      // One commit: git sees the old path's removal and the new file as a rename.
      expect(git(root, "show", "--format=", "--name-status", "--find-renames", "HEAD")).toMatch(
        new RegExp(`^R\\d+\\t${artifact.path}\\tmoved\\.md$`, "m"),
      );
    },
  );

  it("commits the old path's removal when a file moved while oversized is deleted", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Grows" }, LEE);
    const root = first.root;
    first.close();
    const moved = NodePath.join(root, "moved.md");
    NodeFS.renameSync(NodePath.join(root, artifact.path), moved);
    NodeFS.appendFileSync(moved, "x".repeat(10 * 1024 * 1024));
    let store = await openStore(dir);
    store.close();
    NodeFS.rmSync(moved);
    store = await openStore(dir);
    expect(await store.list()).toEqual([]);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(git(root, "log", "-1", "--format=%B")).toContain("T3-Action: removed");
  });
});

describe("commit trailers", () => {
  it("round-trip actor ids and names containing ':' and '%'", () => {
    const actor: LimArtifactActor = { kind: "user", id: "team:lee", name: "Lee: 100%" };
    const message = commitMessage("x", [
      { artifactId: "a", action: "created", actor, summary: "created a" },
    ]);
    expect(parseCommitEvents(message, "2026-10-10T00:00:00.000Z")[0]?.actor).toEqual(actor);
  });

  it("still parse older unescaped trailers", () => {
    const body =
      "x\n\nT3-Artifact: a\nT3-Action: created\nT3-Actor: user:lee:Lee: the boss\nT3-Summary: s\n";
    expect(parseCommitEvents(body, "2026-10-10T00:00:00.000Z")[0]?.actor).toEqual({
      kind: "user",
      id: "lee",
      name: "Lee: the boss",
    });
  });
});
