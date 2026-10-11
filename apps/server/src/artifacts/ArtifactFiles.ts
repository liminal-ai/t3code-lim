// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
// Fork-only (artifacts): files in the store. Paths are confined to the store
// (no `..`, no absolute paths, no symlinks, nothing under the store's own
// `.git`, `.t3` or `.t3-meta` or any other dot entry), writes are atomic, and markdown
// carries its metadata in YAML front matter (`id`, `title`, `tags`).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export class ArtifactPathError extends Error {
  readonly code = "invalid_path";
}

/** Store-internal directories no artifact path may enter. */
const RESERVED_TOP = new Set([".git", ".t3", ".t3-meta"]);

/**
 * Normalizes a store-relative path (`/` separators, no empty or `.` segments)
 * and refuses anything that could leave the store or touch its internals.
 */
export const normalizeRelativePath = (input: string): string => {
  if (input.includes("\0")) throw new ArtifactPathError("paths can't contain NUL");
  const unified = input.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || NodePath.isAbsolute(input)) {
    throw new ArtifactPathError(`absolute paths aren't allowed: ${input}`);
  }
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new ArtifactPathError(`paths can't contain "..": ${input}`);
  }
  if (segments.length > 0 && RESERVED_TOP.has(segments[0]!)) {
    throw new ArtifactPathError(`${segments[0]} is reserved for the store`);
  }
  // The scan skips dot entries, so an artifact there would look removed.
  const hidden = segments.find((segment) => segment.startsWith("."));
  if (hidden !== undefined) {
    throw new ArtifactPathError(`names can't start with ".": ${hidden}`);
  }
  return segments.join("/");
};

const isInside = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * The absolute path for a store-relative path, after checking that every
 * existing component resolves inside the store (a symlinked folder or file
 * pointing elsewhere is refused). `realRoot` is the store's realpath.
 */
export const resolveInStore = async (realRoot: string, relative: string): Promise<string> => {
  const normalized = normalizeRelativePath(relative);
  const absolute = NodePath.join(realRoot, ...normalized.split("/"));
  if (!isInside(realRoot, absolute)) throw new ArtifactPathError(`outside the store: ${relative}`);
  // Walk up to the deepest component that exists and resolve it.
  let probe = absolute;
  for (;;) {
    const real = await NodeFSP.realpath(probe).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (real !== null) {
      if (!isInside(realRoot, real)) {
        throw new ArtifactPathError(`${relative} resolves outside the store`);
      }
      if (real !== probe) {
        throw new ArtifactPathError(`${relative} goes through a symlink`);
      }
      return absolute;
    }
    // A dangling symlink is still a symlink.
    const link = await NodeFSP.lstat(probe).catch(() => null);
    if (link?.isSymbolicLink()) throw new ArtifactPathError(`${relative} goes through a symlink`);
    const parent = NodePath.dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
};

/** Store-relative `/` path from an absolute one inside the store. */
export const toRelative = (realRoot: string, absolute: string) =>
  NodePath.relative(realRoot, absolute).split(NodePath.sep).join("/");

export const kindOfPath = (path: string) => {
  const extension = NodePath.extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "md" as const;
  if (extension === ".html" || extension === ".htm") return "html" as const;
  return "other" as const;
};

/** File-name slug for a title: lowercase words joined by `-`. */
export const slugify = (title: string) => {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "untitled";
};

export const contentRevision = (content: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit milliseconds then 80 random bits, Crockford base32. */
export const newUlid = (now: number = Date.now()) => {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = NodeCrypto.randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i]! % 32];
  return time + random;
};

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface FrontMatter {
  readonly id: string | null;
  readonly title: string | null;
  readonly tags: ReadonlyArray<string>;
  /** Other keys, kept as they were. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface MarkdownFile {
  /** Null when the file has no front matter block. */
  readonly frontMatter: FrontMatter | null;
  readonly body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const asTags = (value: unknown): string[] => {
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((tag) => typeof tag === "string" && tag !== "");
  return [];
};

export const parseMarkdownFile = (text: string): MarkdownFile => {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { frontMatter: null, body: text };
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch {
    // Not YAML we can read: treat it as body, untouched.
    return { frontMatter: null, body: text };
  }
  const record = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const { id, title, tags, ...extra } = record as Record<string, unknown>;
  return {
    frontMatter: {
      id: typeof id === "string" && ULID_PATTERN.test(id) ? id : null,
      title: typeof title === "string" ? title : title == null ? null : String(title),
      tags: [...new Set(asTags(tags))],
      extra,
    },
    body: text.slice(match[0].length),
  };
};

export const renderMarkdownFile = (input: {
  readonly id: string;
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
  readonly body: string;
}) => {
  const data: Record<string, unknown> = { id: input.id, title: input.title };
  if (input.tags.length > 0) data.tags = [...input.tags];
  Object.assign(data, input.extra ?? {});
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n${input.body}`;
};

/** The first `# Heading` of a markdown body, for files adopted without a title. */
export const firstHeading = (body: string) => /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? null;

/** Replaces a file via a temp file in the same directory and a rename. */
/**
 * Writes through a temp file and a rename. `beforeRename` runs synchronously
 * just before the rename (no await in between), so a precondition checked
 * there can't be outdated by anything else in this process; it may throw to
 * abandon the write.
 */
export const writeFileAtomically = async (
  absolute: string,
  contents: string,
  beforeRename?: () => void,
) => {
  const directory = NodePath.dirname(absolute);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temp = NodePath.join(
    directory,
    `.${NodePath.basename(absolute)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(temp, contents, { flag: "wx" });
    beforeRename?.();
    NodeFS.renameSync(temp, absolute);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true });
    throw error;
  }
};
