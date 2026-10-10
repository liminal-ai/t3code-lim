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
  try {
    const parsed = JSON.parse(text) as LinksFile;
    return parsed && typeof parsed.artifacts === "object" ? parsed : null;
  } catch {
    return null;
  }
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

interface FileState {
  readonly text: string;
  readonly size: number;
  readonly mtime: number;
}

const readFileState = async (absolute: string): Promise<FileState | null> => {
  const stat = await NodeFSP.lstat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_TEXT_ARTIFACT_BYTES) return null;
  const text = await NodeFSP.readFile(absolute, "utf8");
  const after = await NodeFSP.stat(absolute);
  return { text, size: after.size, mtime: after.mtimeMs };
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
    current = (await readFileState(absolute)) ?? state;
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
  // Nothing to commit when the outside writer committed the edit itself; the
  // index still changed, so the events stand.
  await ctx.git.commit({ paths, subject, events, author: EXTERNAL_ACTOR });
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
  const idByLinkedPath = new Map(
    Object.entries(linksFile?.artifacts ?? {}).map(([id, entry]) => [entry.path, id]),
  );
  const dirty = new Set(await ctx.git.changedPaths());
  const seen = new Set<string>();
  const commitPaths = new Set<string>();
  const events: Array<ArtifactCommitEvent & { revision: string | null }> = [];

  for (const path of paths) {
    const absolute = NodePath.join(ctx.root, ...path.split("/"));
    const state = await readFileState(absolute);
    if (!state) continue;
    const parsed = parseMarkdownFile(state.text);
    const byPath = ctx.index.getByPath(path);
    // The file's own id wins; a copy of another file's id gets a new one.
    let id = parsed.frontMatter?.id ?? byPath?.id ?? idByLinkedPath.get(path) ?? null;
    if (id !== null && seen.has(id)) id = null;
    const adopted = id === null;
    id ??= newUlid(ctx.now().getTime());
    seen.add(id);
    const previous = ctx.index.get(id);
    if (byPath && byPath.id !== id) ctx.index.remove(byPath.id);
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

  for (const row of ctx.index.all()) {
    if (seen.has(row.id)) continue;
    ctx.index.remove(row.id);
    commitPaths.add(row.path);
    events.push({
      artifactId: row.id,
      action: "removed",
      actor: EXTERNAL_ACTOR,
      summary: `removed ${row.path} outside T3`,
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

  const links = await writeLinksFile(ctx);
  if (links) commitPaths.add(links);
  await commitExternal(ctx, [...commitPaths], events);
};

export type CheckResult = "unchanged" | "reindexed" | "rescanned";

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
  if (!state) {
    await scanStore(ctx, { rebuild: false });
    return "rescanned";
  }
  const { row: next, rewritten } = await indexMarkdown(ctx, row.path, row.id, state, row);
  ctx.index.upsert(next);
  if (!rewritten && next.revision === row.revision) return "unchanged";
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
  return "reindexed";
};
