// @effect-diagnostics nodeBuiltinImport:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { FileUnstableError, readFileState } from "./ArtifactReconcile.ts";

import { resolveArtifactsDir } from "./artifactConfig.ts";
import {
  ArtifactPathError,
  newUlid,
  normalizeRelativePath,
  parseMarkdownFile,
  renderMarkdownFile,
  resolveInStore,
  slugify,
  ULID_PATTERN,
} from "./ArtifactFiles.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "artifact-files-")),
  );
  temps.push(dir);
  return dir;
};

describe("path confinement", () => {
  it("normalizes plain relative paths", () => {
    expect(normalizeRelativePath("t3//backlog.md")).toBe("t3/backlog.md");
    expect(normalizeRelativePath("./a/./b.md")).toBe("a/b.md");
    expect(normalizeRelativePath("a\\b.md")).toBe("a/b.md");
  });

  it.each([
    ["../escape.md"],
    ["a/../../escape.md"],
    ["/etc/passwd"],
    ["C:/Windows/x.md"],
    [".git/config"],
    [".t3/index.sqlite"],
    [".t3-meta/links.json"],
    ["notes/.hidden.md"],
    ["a\0b.md"],
  ])("refuses %j", (input) => {
    expect(() => normalizeRelativePath(input)).toThrow(ArtifactPathError);
  });

  it("refuses a symlinked folder that leaves the store", async () => {
    const root = tempDir();
    const outside = tempDir();
    NodeFS.symlinkSync(outside, NodePath.join(root, "out"));
    await expect(resolveInStore(root, "out/x.md")).rejects.toThrow(ArtifactPathError);
  });

  it("refuses a symlink even when it stays inside the store", async () => {
    const root = tempDir();
    NodeFS.mkdirSync(NodePath.join(root, "real"));
    NodeFS.symlinkSync(NodePath.join(root, "real"), NodePath.join(root, "alias"));
    await expect(resolveInStore(root, "alias/x.md")).rejects.toThrow(/symlink/);
  });

  it("refuses a dangling symlinked file", async () => {
    const root = tempDir();
    NodeFS.symlinkSync("/nonexistent/target.md", NodePath.join(root, "dangling.md"));
    await expect(resolveInStore(root, "dangling.md")).rejects.toThrow(/symlink/);
  });

  it("resolves new and existing paths inside the store", async () => {
    const root = tempDir();
    expect(await resolveInStore(root, "new/folder/x.md")).toBe(
      NodePath.join(root, "new/folder/x.md"),
    );
  });
});

describe("front matter", () => {
  it("round-trips id, title, tags and other keys", () => {
    const id = newUlid();
    const text = renderMarkdownFile({
      id,
      title: "Back: log",
      tags: ["t3"],
      extra: { owner: "lee" },
      body: "- [ ] a\n",
    });
    const parsed = parseMarkdownFile(text);
    expect(parsed.frontMatter).toEqual({
      id,
      title: "Back: log",
      tags: ["t3"],
      extra: { owner: "lee" },
    });
    expect(parsed.body).toBe("- [ ] a\n");
  });

  it("treats a file without front matter as all body", () => {
    expect(parseMarkdownFile("# Hi\n")).toEqual({ frontMatter: null, body: "# Hi\n" });
  });

  it("ignores an id that isn't a ULID and reads comma-separated tags", () => {
    const parsed = parseMarkdownFile("---\nid: nope\ntitle: T\ntags: a, b\n---\nbody");
    expect(parsed.frontMatter?.id).toBeNull();
    expect(parsed.frontMatter?.tags).toEqual(["a", "b"]);
    expect(parsed.body).toBe("body");
  });

  it("leaves unreadable YAML in the body", () => {
    const text = "---\n: : :\n  - [\n---\nbody";
    expect(parseMarkdownFile(text).frontMatter).toBeNull();
  });
});

describe("names and ids", () => {
  it("slugifies titles", () => {
    expect(slugify("Lee's Backlog: Phase A!")).toBe("lee-s-backlog-phase-a");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("makes sortable ULIDs", () => {
    const a = newUlid(1_000);
    const b = newUlid(2_000);
    expect(a).toMatch(ULID_PATTERN);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe("store location", () => {
  it("defaults to <baseDir>/artifacts beside userdata, and dev servers get their own", () => {
    expect(resolveArtifactsDir({ baseDir: "/b", stateDir: "/b/userdata" }, {})).toBe(
      "/b/artifacts",
    );
    expect(resolveArtifactsDir({ baseDir: "/b", stateDir: "/b/dev" }, {})).toBe("/b/dev/artifacts");
    expect(
      resolveArtifactsDir(
        { baseDir: "/b", stateDir: "/b/userdata" },
        { T3_ARTIFACTS_DIR: "/tmp/qa" },
      ),
    ).toBe("/tmp/qa");
  });
});

describe("readFileState", () => {
  /** A file whose contents change while it is read, `versions` times. */
  const changingFile = (versions: ReadonlyArray<string>) => {
    let version = 0;
    let reads = 0;
    const statOf = () => ({
      size: Buffer.byteLength(versions[version]!),
      mtimeMs: version,
      isFile: () => true,
    });
    const handle = {
      stat: async () => statOf(),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytes = Buffer.from(versions[version]!);
        const bytesRead = bytes.copy(buffer, offset, position, position + length);
        // An in-place write lands during each read, until the last version.
        if (++reads && version < versions.length - 1) version++;
        return { bytesRead, buffer };
      },
      close: async () => undefined,
    };
    return { lstat: async () => statOf(), open: async () => handle } as never;
  };

  it("rereads the whole file from the start when an in-place write lands mid-read", async () => {
    const state = await readFileState("/x.md", changingFile(["one\n", "two\n"]));
    expect(state).toEqual({ text: "two\n", size: 4, mtime: 1 });
  });

  it("refuses a file that keeps changing on every read", async () => {
    await expect(
      readFileState("/x.md", changingFile(["a", "bb", "ccc", "dddd", "eeeee"])),
    ).rejects.toBeInstanceOf(FileUnstableError);
  });
});
