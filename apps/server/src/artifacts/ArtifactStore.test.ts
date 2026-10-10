import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LimArtifactActor, LimArtifactChange } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
      { title: "x", name: "x.html" },
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

  it("gives a copied file its own id", async () => {
    const dir = tempStoreDir();
    const first = await ArtifactStore.open(dir);
    const { artifact } = await first.create({ title: "Original" }, LEE);
    first.close();
    NodeFS.copyFileSync(NodePath.join(dir, artifact.path), NodePath.join(dir, "zz-copy.md"));
    const second = await openStore(dir);
    const listed = await second.list();
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((entry) => entry.id)).size).toBe(2);
    expect(listed.find((entry) => entry.path === artifact.path)?.id).toBe(artifact.id);
  });

  it("refuses markdown over 10 MB", async () => {
    const store = await openStore(tempStoreDir());
    await expectStoreError(
      store.create({ title: "Huge", content: "x".repeat(10 * 1024 * 1024 + 1) }, LEE),
      "too_large",
    );
    expect(git(store.root, "status", "--porcelain").trim()).toBe("");
  });
});
