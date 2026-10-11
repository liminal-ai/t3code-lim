// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
// Fork-only (artifacts): keeping the index true to the files without a
// filesystem watcher. A scan at startup, and a size/mtime check before every
// read and write, find edits made outside T3 (an agent's own file tools, an
// editor, git) and commit them as "external" before anything is served or
// applied. When the index is new (deleted, unreadable or an old schema), the
// scan rebuilds it: artifacts and tags from the files, links from
// `.t3-meta/links.json`, events from the commit log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { LimArtifactActor, LimArtifactLink } from "@t3tools/contracts";

import { MAX_TEXT_ARTIFACT_BYTES } from "./artifactConfig.ts";
import {
  contentRevision,
  firstHeading,
  kindOfPath,
  newUlid,
  parseMarkdownFile,
  renderMarkdownFile,
  toRelative,
  writeFileAtomically,
} from "./ArtifactFiles.ts";
import type { ArtifactCommitEvent, ArtifactGit } from "./ArtifactGit.ts";
import type { ArtifactEventRow, ArtifactIndex, ArtifactRow } from "./ArtifactIndex.ts";

export const LINKS_FILE = ".t3-meta/links.json";

/** A path no file can have: where a scan parks a row whose path another file took. */
const PARKED = ".t3-parked/";

export const EXTERNAL_ACTOR: LimArtifactActor = {
  kind: "external",
  id: "outside-t3",
  name: "External edit",
};

export interface ReconcileContext {
  readonly root: string;
  readonly index: ArtifactIndex;
  readonly git: ArtifactGit;
  readonly now: () => Date;
  /** Every event recorded, after its commit. */
  readonly emit: (event: ArtifactEventRow) => void;
}

interface LinksFile {
  readonly version: 1;
  readonly artifacts: Record<
    string,
    { readonly path: string; readonly links: ReadonlyArray<LimArtifactLink> }
  >;
}

const EMPTY_LINKS_FILE = `${JSON.stringify({ version: 1, artifacts: {} }, null, 2)}\n`;

/** `.t3-meta/links.json` as the index says it should be: artifacts with links, sorted. */
export const renderLinksFile = (index: ArtifactIndex) => {
  const artifacts: Record<string, { path: string; links: LimArtifactLink[] }> = {};
  const byArtifact = index.allLinks();
  for (const id of [...byArtifact.keys()].sort()) {
    const row = index.get(id);
    const links = byArtifact.get(id)!;
    if (row && links.length > 0) {
      artifacts[id] = {
        path: row.path,
        links: [...links].sort((a, b) => a.threadId.localeCompare(b.threadId)),
      };
    }
  }
  const file: LinksFile = { version: 1, artifacts };
  return `${JSON.stringify(file, null, 2)}\n`;
};

/** Rewrites links.json when it differs; returns its path when it changed. */
export const writeLinksFile = async (ctx: ReconcileContext): Promise<string | null> => {
  const absolute = NodePath.join(ctx.root, ...LINKS_FILE.split("/"));
  const next = renderLinksFile(ctx.index);
  const current = await NodeFSP.readFile(absolute, "utf8").catch(() => null);
  if (current === next) return null;
  if (current === null && next === EMPTY_LINKS_FILE) return null;
  await writeFileAtomically(absolute, next);
  return LINKS_FILE;
};

const readLinksFile = async (root: string): Promise<LinksFile | null> => {
  const text = await NodeFSP.readFile(NodePath.join(root, ...LINKS_FILE.split("/")), "utf8").catch(
    () => null,
  );
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Hand-edited metadata must never stop the store opening: entries and links
  // that aren't well formed are skipped, the rest restored.
  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  const valid: Record<string, { path: string; links: LimArtifactLink[] }> = {};
  for (const [id, entry] of Object.entries(artifacts)) {
    const { path, links } = (entry ?? {}) as { path?: unknown; links?: unknown };
    if (typeof path !== "string" || !Array.isArray(links)) continue;
    valid[id] = { path, links: links.filter(isLink) };
  }
  return { version: 1, artifacts: valid };
};

const isActor = (value: unknown): value is LimArtifactActor => {
  const actor = value as Partial<LimArtifactActor> | null;
  return (
    typeof actor?.id === "string" &&
    typeof actor.name === "string" &&
    ["user", "agent", "external", "system"].includes(actor.kind as string)
  );
};

const isLink = (value: unknown): value is LimArtifactLink => {
  const link = value as Partial<LimArtifactLink> | null;
  return (
    typeof link?.threadId === "string" &&
    (link.access === "read" || link.access === "write") &&
    typeof link.linkedAt === "string" &&
    isActor(link.linkedBy)
  );
};

/** Store-relative paths of markdown files, skipping dot entries and symlinks. */
const walkMarkdown = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (directory: string) => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && kindOfPath(entry.name) === "md") {
        found.push(toRelative(root, absolute));
      }
    }
  };
  await visit(root);
  return found.sort();
};

/** A file's front matter, reading only its head (for files too large to read whole). */
const headFrontMatter = async (absolute: string) => {
  const handle = await NodeFSP.open(absolute, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return parseMarkdownFile(head.subarray(0, bytesRead).toString("utf8")).frontMatter ?? null;
  } finally {
    await handle.close();
  }
};

/** A file kept changing while it was read. */
export class FileUnstableError extends Error {}

export interface FileState {
  readonly text: string;
  readonly size: number;
  readonly mtime: number;
}

/**
 * The file's bytes with the size and mtime of those same bytes: read through
 * one handle, so an editor replacing the file meanwhile can't pair old text
 * with the new file's metadata (the next check then sees the new file). An
 * in-place write during the read is retried.
 */
export const readFileState = async (
  absolute: string,
  fs: Pick<typeof NodeFSP, "lstat" | "open"> = NodeFSP,
): Promise<FileState | "too_large" | null> => {
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_TEXT_ARTIFACT_BYTES) return "too_large";
  const handle = await fs.open(absolute, "r").catch(() => null);
  if (!handle) return null;
  try {
    for (let attempt = 1; ; attempt++) {
      const opened = await handle.stat();
      if (opened.size > MAX_TEXT_ARTIFACT_BYTES) return "too_large";
      // Positional reads from offset 0, so a retry rereads the whole file
      // (readFile would continue from where the last read stopped).
      const buffer = Buffer.alloc(opened.size);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const text = buffer.subarray(0, length).toString("utf8");
      const after = await handle.stat();
      if (after.size === opened.size && after.mtimeMs === opened.mtimeMs) {
        return { text, size: after.size, mtime: after.mtimeMs };
      }
      // Never index a read that may be torn: refuse, and the caller retries later.
      if (attempt >= 3) throw new FileUnstableError(absolute);
    }
  } finally {
    await handle.close();
  }
};

/**
 * Index state for a markdown file, giving it `id` (rewriting its front matter
 * when the file lacks that id). Returns the row and whether the file was rewritten.
 */
const indexMarkdown = async (
  ctx: ReconcileContext,
  path: string,
  id: string,
  state: FileState,
  previous: ArtifactRow | undefined,
): Promise<{ row: ArtifactRow; rewritten: boolean }> => {
  const absolute = NodePath.join(ctx.root, ...path.split("/"));
  const parsed = parseMarkdownFile(state.text);
  let current = state;
  let rewritten = false;
  const title =
    parsed.frontMatter?.title?.trim() ||
    previous?.title ||
    firstHeading(parsed.body) ||
    NodePath.basename(path, NodePath.extname(path));
  if (parsed.frontMatter?.id !== id) {
    await writeFileAtomically(
      absolute,
      renderMarkdownFile({
        id,
        title,
        tags: parsed.frontMatter?.tags ?? [],
        extra: parsed.frontMatter?.extra,
        body: parsed.body,
      }),
    );
    const after = await readFileState(absolute);
    if (after !== null && after !== "too_large") current = after;
    rewritten = true;
  }
  const at = ctx.now().toISOString();
  return {
    rewritten,
    row: {
      id,
      path,
      title,
      kind: "md",
      state: previous?.state ?? "kept",
      createdBy: previous?.createdBy ?? null,
      createdAt: previous?.createdAt ?? new Date(state.mtime).toISOString(),
      updatedAt:
        previous && previous.revision === contentRevision(current.text) ? previous.updatedAt : at,
      revision: contentRevision(current.text),
      size: current.size,
      mtime: current.mtime,
      bodyText: parsed.body,
      tags: parsed.frontMatter?.tags ?? [],
    },
  };
};

/** Commits external changes and records one event per artifact. */
const commitExternal = async (
  ctx: ReconcileContext,
  paths: ReadonlyArray<string>,
  events: ReadonlyArray<ArtifactCommitEvent & { readonly revision: string | null }>,
) => {
  if (paths.length === 0) return;
  const subject =
    events.length === 1
      ? `External edit: ${ctx.index.get(events[0]!.artifactId)?.path ?? events[0]!.summary}`
      : `External edits (${events.length} artifacts)`;
  // When the outside writer committed the edit itself, an empty commit still
  // carries the events, so a rebuilt index recovers them.
  await ctx.git.commit({ paths, subject, events, author: EXTERNAL_ACTOR, keepEvents: true });
  const at = ctx.now().toISOString();
  for (const event of events) {
    ctx.emit(
      ctx.index.addEvent({
        artifactId: event.artifactId,
        at,
        actor: event.actor,
        action: event.action,
        itemId: null,
        summary: event.summary,
        revision: event.revision,
      }),
    );
  }
};

/** Rebuild only: events from the commit log, and who created each artifact. */
const restoreEvents = async (ctx: ReconcileContext) => {
  const logged = await ctx.git.loggedEvents();
  const first = new Map<string, { actor: LimArtifactActor; at: string }>();
  const last = new Map<string, string>();
  for (const event of logged) {
    if (!ctx.index.get(event.artifactId)) continue;
    ctx.index.addEvent({
      artifactId: event.artifactId,
      at: event.at,
      actor: event.actor,
      action: event.action,
      itemId: event.itemId ?? null,
      summary: event.summary,
      revision: null,
    });
    if (!first.has(event.artifactId)) first.set(event.artifactId, event);
    last.set(event.artifactId, event.at);
  }
  for (const [id, created] of first) ctx.index.setCreated(id, created.actor, created.at);
  for (const [id, at] of last) ctx.index.setUpdatedAt(id, at);
};

/**
 * The startup scan: indexes every markdown file, adopts new ones (giving them
 * an id), notices moves and removals, and commits whatever changed outside T3.
 * With `rebuild`, also restores links and events.
 */
export const scanStore = async (ctx: ReconcileContext, options: { rebuild: boolean }) => {
  const paths = await walkMarkdown(ctx.root);
  const linksFile = options.rebuild ? await readLinksFile(ctx.root) : null;
  const linkedEntries = Object.entries(linksFile?.artifacts ?? {});
  const idByLinkedPath = new Map(linkedEntries.map(([id, entry]) => [entry.path, id]));
  const idPathFromLinks = new Map(linkedEntries.map(([id, entry]) => [id, entry.path]));
  const dirty = new Set(await ctx.git.changedPaths());
  // The index as it was: moves and swaps are judged against it, and an artifact
  // is removed only when no file carries it after the whole scan.
  const before = new Map(ctx.index.all().map((row) => [row.id, row]));
  const linksByIdBefore = ctx.index.allLinks();
  const seen = new Set<string>();
  const tooLarge = new Set<string>();
  // Ids in oversized files' front matter, and where those files are now: such
  // an artifact may also have moved, and its id is reserved for it.
  const tooLargeIds = new Map<string, string>();
  const tooLargeTitles = new Map<string, string>();
  const commitPaths = new Set<string>();
  const events: Array<ArtifactCommitEvent & { revision: string | null }> = [];

  const files: Array<{ path: string; state: FileState; fileId: string | null }> = [];
  for (const path of paths) {
    const state = await readFileState(NodePath.join(ctx.root, ...path.split("/")));
    if (state === "too_large") {
      tooLarge.add(path);
      const front = await headFrontMatter(NodePath.join(ctx.root, ...path.split("/")));
      const id = front?.id ?? null;
      if (id !== null && !tooLargeIds.has(id)) {
        tooLargeIds.set(id, path);
        tooLargeTitles.set(
          id,
          front?.title?.trim() || NodePath.basename(path, NodePath.extname(path)),
        );
      }
    }
    if (state === null || state === "too_large") continue;
    files.push({ path, state, fileId: parseMarkdownFile(state.text).frontMatter?.id ?? null });
  }
  // When two files carry one id (a copy), the file the index or links.json
  // already knows at that path keeps it, then other files carrying that id,
  // then id-less new ones.
  const claim = (file: (typeof files)[number]) => {
    if (file.fileId !== null) {
      const known = ctx.index.get(file.fileId)?.path ?? idPathFromLinks.get(file.fileId);
      if (known === file.path) return 0;
      // Prefer files that carry the id themselves over id-less occupants.
      return 1;
    }
    // Id-less files claim last to avoid stealing identity from moved files.
    return 2;
  };
  files.sort((a, b) => claim(a) - claim(b));

  for (const { path, state, fileId } of files) {
    const byPath = ctx.index.getByPath(path);
    let id = fileId ?? byPath?.id ?? idByLinkedPath.get(path) ?? null;
    if (id !== null && seen.has(id)) id = null;
    // An id only reaches this file by its path (it carries none): never take
    // one an oversized file still carries elsewhere.
    if (id !== null && fileId === null && tooLargeIds.has(id)) id = null;
    const adopted = id === null;
    id ??= newUlid(ctx.now().getTime());
    seen.add(id);
    const previous = before.get(id);
    // Another artifact is indexed at this path (two files swapped, or a file
    // moved onto it): park its row, links intact, until its own file turns up.
    if (byPath && byPath.id !== id) ctx.index.upsert({ ...byPath, path: `${PARKED}${byPath.id}` });
    const { row, rewritten } = await indexMarkdown(ctx, path, id, state, previous);
    ctx.index.upsert(row);
    const moved = previous !== undefined && previous.path !== path;
    const edited = previous !== undefined && previous.revision !== row.revision;
    if (rewritten || dirty.has(path) || moved || edited || (adopted && !options.rebuild)) {
      commitPaths.add(path);
      if (moved) commitPaths.add(previous.path);
      const action = adopted ? "adopted" : moved ? "moved" : "external";
      events.push({
        artifactId: id,
        action,
        actor: EXTERNAL_ACTOR,
        summary: adopted ? `adopted ${path}` : moved ? `moved to ${path}` : `edited outside T3`,
        revision: row.revision,
      });
    }
  }

  // An oversized artifact the index doesn't have (it was rebuilt meanwhile)
  // gets a placeholder row, so its links are restored and kept; its size and
  // mtime never match, so it answers too_large until the file shrinks.
  for (const [id, path] of tooLargeIds) {
    if (seen.has(id) || ctx.index.get(id) || ctx.index.getByPath(path)) continue;
    const at = ctx.now().toISOString();
    ctx.index.upsert({
      id,
      path,
      title: tooLargeTitles.get(id) ?? id,
      kind: "md",
      state: "kept",
      createdBy: null,
      createdAt: at,
      updatedAt: at,
      revision: "",
      size: -1,
      mtime: -1,
      bodyText: "",
      tags: [],
    });
  }

  for (const row of ctx.index.all()) {
    if (seen.has(row.id)) continue;
    const original = before.get(row.id) ?? row;
    const path = original.path;
    // Grown past the size limit outside T3: not served, but the row and its
    // links stay, at the oversized file's path (it may have moved), so it
    // returns whole once the file shrinks.
    const oversizedAt = tooLargeIds.get(row.id) ?? (tooLarge.has(path) ? path : undefined);
    if (oversizedAt !== undefined) {
      ctx.index.upsert({ ...original, path: oversizedAt });
      continue;
    }
    ctx.index.remove(row.id);
    commitPaths.add(path);
    events.push({
      artifactId: row.id,
      action: "removed",
      actor: EXTERNAL_ACTOR,
      summary: `removed ${path} outside T3`,
      revision: null,
    });
  }

  if (options.rebuild) {
    for (const [id, entry] of Object.entries(linksFile?.artifacts ?? {})) {
      if (!ctx.index.get(id)) continue;
      for (const link of entry.links) ctx.index.setLink(id, link);
    }
    await restoreEvents(ctx);
  }

  const linksBefore = await NodeFSP.readFile(
    NodePath.join(ctx.root, ...LINKS_FILE.split("/")),
    "utf8",
  ).catch(() => null);
  const links = await writeLinksFile(ctx);
  if (links) commitPaths.add(links);
  try {
    await commitExternal(ctx, [...commitPaths], events);
  } catch (error) {
    // Put the index and links.json back as they were, so the next access
    // rescans and retries the commit with its events (a removed row or a
    // moved one already at its destination would otherwise never retry).
    ctx.index.transaction(() => {
      for (const row of ctx.index.all()) if (!before.has(row.id)) ctx.index.remove(row.id);
      for (const [id, row] of before) {
        ctx.index.upsert(row);
        ctx.index.replaceLinks(id, linksByIdBefore.get(id) ?? []);
      }
    });
    if (links) {
      const absolute = NodePath.join(ctx.root, ...LINKS_FILE.split("/"));
      if (linksBefore === null) await NodeFSP.rm(absolute, { force: true });
      else await writeFileAtomically(absolute, linksBefore);
    }
    await ctx.git.unstage([...commitPaths]).catch(() => undefined);
    throw error;
  }
};

export type CheckResult = "unchanged" | "reindexed" | "rescanned" | "too_large";

/**
 * The per-access check: when the file's size or mtime differs from the index,
 * reindex it and commit the edit as "external" first. A missing file means a
 * move or removal outside T3, so the whole store is rescanned.
 */
export const checkArtifact = async (
  ctx: ReconcileContext,
  row: ArtifactRow,
): Promise<CheckResult> => {
  const absolute = NodePath.join(ctx.root, ...row.path.split("/"));
  const stat = await NodeFSP.lstat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    await scanStore(ctx, { rebuild: false });
    return "rescanned";
  }
  if (stat.size === row.size && stat.mtimeMs === row.mtime) return "unchanged";
  const state = await readFileState(absolute);
  // Over the size limit: kept, with its links, but not served.
  if (state === "too_large") return "too_large";
  if (state === null) {
    await scanStore(ctx, { rebuild: false });
    return "rescanned";
  }
  const { row: next, rewritten } = await indexMarkdown(ctx, row.path, row.id, state, row);
  ctx.index.upsert(next);
  if (!rewritten && next.revision === row.revision) return "unchanged";
  try {
    await commitExternal(
      ctx,
      [row.path],
      [
        {
          artifactId: row.id,
          action: "external",
          actor: EXTERNAL_ACTOR,
          summary: "edited outside T3",
          revision: next.revision,
        },
      ],
    );
  } catch (error) {
    // Back to the old row, so the next access sees the edit again and retries
    // the commit instead of serving it with no history.
    ctx.index.upsert(row);
    await ctx.git.unstage([row.path]).catch(() => undefined);
    throw error;
  }
  return "reindexed";
};
