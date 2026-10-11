// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
// Fork-only (artifacts): the store. Files plus git under one directory, a
// rebuildable index beside them, list ops, links to threads, and a change feed
// for watchers. Every change is one commit; `.t3-meta/links.json` is written in
// the same commit as every attach and detach. Changes are serialized (one
// writer at a time across the store, so per artifact too, and git's index is
// never shared between two commits).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  LimArtifactActor,
  LimArtifactChange,
  LimArtifactLink,
  LimArtifactLinkAccess,
  LimArtifactListItem,
  LimArtifactListOp,
  LimArtifactSummary,
} from "@t3tools/contracts";

import { MAX_TEXT_ARTIFACT_BYTES } from "./artifactConfig.ts";
import {
  ArtifactPathError,
  contentRevision,
  kindOfPath,
  newUlid,
  normalizeRelativePath,
  parseMarkdownFile,
  renderMarkdownFile,
  resolveInStore,
  slugify,
  ULID_PATTERN,
  writeFileAtomically,
} from "./ArtifactFiles.ts";
import { ArtifactGit, type ArtifactCommitEvent } from "./ArtifactGit.ts";
import {
  ArtifactIndex,
  type ArtifactEventRow,
  type ArtifactRow,
  type ListFilter,
} from "./ArtifactIndex.ts";
import {
  checkArtifact,
  LINKS_FILE,
  scanStore,
  writeLinksFile,
  type ReconcileContext,
} from "./ArtifactReconcile.ts";
import {
  applyListOps,
  assignItemIds,
  inlineTags,
  ListOpError,
  listItems,
  parseList,
  renderList,
} from "./listOps.ts";

export type ArtifactErrorCode =
  | "not_found"
  | "item_not_found"
  | "invalid_request"
  | "invalid_path"
  | "too_large"
  | "unavailable";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactErrorCode;
  readonly currentRevision: string | undefined;

  constructor(code: ArtifactErrorCode, message: string, currentRevision?: string) {
    super(message);
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export interface CreateInput {
  readonly title: string;
  readonly content?: string | undefined;
  readonly folder?: string | undefined;
  readonly name?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly attach?:
    | ReadonlyArray<{
        readonly threadId: string;
        readonly access?: LimArtifactLinkAccess | undefined;
      }>
    | undefined;
}

export interface ReadResult {
  readonly artifact: LimArtifactSummary;
  readonly content: string;
  readonly items: ReadonlyArray<LimArtifactListItem>;
}

export interface OpsResult {
  readonly artifact: LimArtifactSummary;
  readonly items: ReadonlyArray<LimArtifactListItem>;
  readonly itemIds: ReadonlyArray<string>;
}

type Listener = (change: LimArtifactChange) => void;

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const toChange = (event: ArtifactEventRow): LimArtifactChange => ({
  seq: event.seq,
  artifactId: event.artifactId,
  at: event.at,
  action: event.action,
  actor: event.actor,
  summary: event.summary,
  itemId: event.itemId,
  revision: event.revision,
});

const cleanTags = (tags: ReadonlyArray<string> | undefined) => [
  ...new Set((tags ?? []).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean)),
];

/**
 * What a change touched, so a failed commit can put it back: the files' bytes,
 * and the index rows and links. Without it a failed commit left the edit
 * applied but uncommitted, and a retried `add` applied twice.
 */
class Undo {
  private readonly files = new Map<string, Buffer | null>();
  private readonly artifacts = new Map<
    string,
    { readonly row: ArtifactRow | undefined; readonly links: LimArtifactLink[] }
  >();

  private readonly root: string;
  private readonly index: ArtifactIndex;

  constructor(root: string, index: ArtifactIndex) {
    this.root = root;
    this.index = index;
  }

  file(path: string) {
    if (this.files.has(path)) return;
    const absolute = NodePath.join(this.root, ...path.split("/"));
    this.files.set(path, NodeFS.existsSync(absolute) ? NodeFS.readFileSync(absolute) : null);
  }

  artifact(id: string) {
    if (this.artifacts.has(id)) return;
    this.artifacts.set(id, { row: this.index.get(id), links: this.index.links(id) });
  }

  async restore(git: ArtifactGit) {
    for (const [path, bytes] of this.files) {
      const absolute = NodePath.join(this.root, ...path.split("/"));
      if (bytes === null) NodeFS.rmSync(absolute, { force: true });
      else await writeFileAtomically(absolute, bytes.toString("utf8"));
    }
    this.index.transaction(() => {
      for (const [id, { row, links }] of this.artifacts) {
        if (!row) {
          this.index.remove(id);
          continue;
        }
        this.index.upsert(row);
        this.index.replaceLinks(id, links);
      }
    });
    await git.unstage([...this.files.keys()]);
  }
}

/** The file changed outside T3 between reading it and writing the edit. */
class FileChangedError extends Error {}

/** One writer at a time: each task runs after the previous one settles. */
class Serializer {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class ArtifactStore {
  private readonly listeners = new Set<Listener>();
  private readonly serializer = new Serializer();
  private readonly ctx: ReconcileContext;

  readonly root: string;
  private readonly index: ArtifactIndex;
  private readonly git: ArtifactGit;
  private readonly now: () => Date;
  private readonly random: (() => number) | undefined;

  private constructor(input: {
    readonly root: string;
    readonly index: ArtifactIndex;
    readonly git: ArtifactGit;
    readonly now: () => Date;
    readonly random: (() => number) | undefined;
  }) {
    this.root = input.root;
    this.index = input.index;
    this.git = input.git;
    this.now = input.now;
    this.random = input.random;
    this.ctx = {
      root: input.root,
      index: input.index,
      git: input.git,
      now: input.now,
      emit: (event) => this.emit(event),
    };
  }

  /**
   * Opens (creating when needed) the store at `dir`, then runs the startup scan:
   * a missing or outdated index is rebuilt, and edits made while T3 was down
   * are committed as external.
   */
  static async open(
    dir: string,
    options: { readonly now?: () => Date; readonly random?: () => number } = {},
  ): Promise<ArtifactStore> {
    NodeFS.mkdirSync(dir, { recursive: true });
    const root = NodeFS.realpathSync(dir);
    const git = new ArtifactGit(root);
    await git.ensureRepo();
    NodeFS.mkdirSync(NodePath.join(root, ".t3"), { recursive: true });
    const index = ArtifactIndex.open(NodePath.join(root, ".t3", "index.sqlite"), (file) =>
      NodeFS.rmSync(file, { force: true }),
    );
    const store = new ArtifactStore({
      root,
      index,
      git,
      now: options.now ?? (() => new Date()),
      random: options.random,
    });
    try {
      await store.serializer.run(() => scanStore(store.ctx, { rebuild: index.created }));
    } catch (error) {
      index.close();
      throw error;
    }
    return store;
  }

  close() {
    this.listeners.clear();
    this.index.close();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The newest change's sequence number, so a watcher can say where it started. */
  lastSeq() {
    return this.index.lastSeq();
  }

  private emit(event: ArtifactEventRow) {
    const change = toChange(event);
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // One broken watcher never blocks a write or the others.
      }
    }
  }

  private summary(row: ArtifactRow): LimArtifactSummary {
    return {
      id: row.id,
      path: row.path,
      absolutePath: NodePath.join(this.root, ...row.path.split("/")),
      title: row.title,
      kind: row.kind,
      state: row.state,
      tags: row.tags,
      revision: row.revision,
      size: row.size,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      links: this.index.links(row.id),
    };
  }

  private items(id: string, body: string): LimArtifactListItem[] {
    const last = this.index.lastItemEvents(id);
    return listItems(parseList(body)).map((item) => {
      const change = item.id ? last.get(item.id) : undefined;
      return {
        id: item.id,
        checked: item.checked,
        text: item.text,
        tags: inlineTags(item.text),
        details: item.details.join("\n"),
        lastChange: change ? { at: change.at, action: change.action, actor: change.actor } : null,
      };
    });
  }

  /** The artifact's row after the per-access check; fails when it no longer exists. */
  private async current(id: string): Promise<ArtifactRow> {
    if (!ULID_PATTERN.test(id)) throw new ArtifactStoreError("not_found", `no artifact ${id}`);
    const row = this.index.get(id);
    if (!row) throw new ArtifactStoreError("not_found", `no artifact ${id}`);
    if ((await checkArtifact(this.ctx, row)) === "too_large") {
      throw new ArtifactStoreError(
        "too_large",
        `${row.path} grew past 10 MB outside T3; it's kept, with its links, but not served until it shrinks`,
      );
    }
    const fresh = this.index.get(id);
    if (!fresh) throw new ArtifactStoreError("not_found", `artifact ${id} was removed outside T3`);
    return fresh;
  }

  /** Runs a change; when it fails (a git commit that didn't land), undoes what it touched. */
  private async undoable<T>(undo: Undo, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      await undo.restore(this.git);
      throw error;
    }
  }

  private readBody(row: ArtifactRow) {
    const text = NodeFS.readFileSync(NodePath.join(this.root, ...row.path.split("/")), "utf8");
    return parseMarkdownFile(text);
  }

  list(filter: ListFilter = {}): Promise<LimArtifactSummary[]> {
    return this.serializer.run(async () => {
      const oversized = new Set<string>();
      for (const { id } of this.index.all()) {
        // An earlier check may have rescanned (a move or removal): use the row as it is now.
        const row = this.index.get(id);
        if (row && (await checkArtifact(this.ctx, row)) === "too_large") oversized.add(id);
      }
      return this.index
        .list(filter)
        .filter((row) => !oversized.has(row.id))
        .map((row) => this.summary(row));
    });
  }

  read(id: string): Promise<ReadResult> {
    return this.serializer.run(async () => {
      const row = await this.current(id);
      const { body } = this.readBody(row);
      return { artifact: this.summary(row), content: body, items: this.items(row.id, body) };
    });
  }

  /** Records events for a commit that just landed and tells watchers. */
  private record(
    events: ReadonlyArray<ArtifactCommitEvent>,
    revision: string | null,
  ): ArtifactEventRow[] {
    const at = this.now().toISOString();
    return events.map((event) => {
      const row = this.index.addEvent({
        artifactId: event.artifactId,
        at,
        actor: event.actor,
        action: event.action,
        itemId: event.itemId ?? null,
        summary: event.summary,
        revision,
      });
      this.emit(row);
      return row;
    });
  }

  /**
   * Writes a markdown artifact's file and returns its new index row. With
   * `expect` (the file as last read), throws FileChangedError instead of
   * overwriting a newer outside edit.
   */
  private async writeMarkdown(
    row: Omit<ArtifactRow, "revision" | "size" | "mtime" | "bodyText">,
    body: string,
    extra?: Readonly<Record<string, unknown>>,
    expect?: { readonly size: number; readonly mtime: number },
  ): Promise<ArtifactRow> {
    const text = renderMarkdownFile({ id: row.id, title: row.title, tags: row.tags, extra, body });
    if (Buffer.byteLength(text) > MAX_TEXT_ARTIFACT_BYTES) {
      throw new ArtifactStoreError("too_large", "markdown artifacts are limited to 10 MB");
    }
    const absolute = await resolveInStore(this.root, row.path);
    if (expect) {
      const before = NodeFS.statSync(absolute, { throwIfNoEntry: false });
      if (!before || before.size !== expect.size || before.mtimeMs !== expect.mtime) {
        throw new FileChangedError(row.path);
      }
    }
    await writeFileAtomically(absolute, text);
    const stat = NodeFS.statSync(absolute);
    return {
      ...row,
      revision: contentRevision(text),
      size: stat.size,
      mtime: stat.mtimeMs,
      bodyText: body,
    };
  }

  private async uniquePath(folder: string, name: string) {
    const extension = NodePath.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let attempt = 1; attempt < 1000; attempt++) {
      const fileName = attempt === 1 ? name : `${stem}-${attempt}${extension}`;
      const path = normalizeRelativePath(folder ? `${folder}/${fileName}` : fileName);
      const absolute = await resolveInStore(this.root, path);
      if (!NodeFS.existsSync(absolute) && !this.index.getByPath(path)) return path;
    }
    throw new ArtifactStoreError("invalid_request", `too many artifacts named ${name}`);
  }

  create(input: CreateInput, actor: LimArtifactActor): Promise<ReadResult> {
    return this.serializer.run(async () => {
      const title = input.title.trim();
      if (!title) throw new ArtifactStoreError("invalid_request", "a title is required");
      const folder = normalizeRelativePath(input.folder ?? "");
      let name = input.name?.trim() || `${slugify(title)}.md`;
      if (name.includes("/") || name.includes("\\")) {
        throw new ArtifactPathError("a name can't contain a folder; use `folder`");
      }
      if (!NodePath.extname(name)) name = `${name}.md`;
      if (kindOfPath(name) !== "md") {
        throw new ArtifactStoreError(
          "invalid_request",
          "only markdown artifacts can be created yet",
        );
      }
      const attach = input.attach ?? [];
      for (const link of attach) this.checkThreadId(link.threadId);
      const path = await this.uniquePath(folder, name);
      const body = renderList(assignItemIds(parseList(input.content ?? ""), this.random));
      const at = this.now().toISOString();
      const id = newUlid(this.now().getTime());
      const undo = new Undo(this.root, this.index);
      undo.file(path);
      undo.file(LINKS_FILE);
      undo.artifact(id);
      return this.undoable(undo, async () => {
        const row = await this.writeMarkdown(
          {
            id,
            path,
            title,
            kind: "md",
            state: "kept",
            createdBy: actor,
            createdAt: at,
            updatedAt: at,
            tags: cleanTags(input.tags),
          },
          body,
        );
        const events: ArtifactCommitEvent[] = [
          { artifactId: id, action: "created", actor, summary: `created ${path}` },
        ];
        this.index.transaction(() => {
          this.index.upsert(row);
          for (const link of attach) {
            this.index.setLink(id, {
              threadId: link.threadId,
              access: link.access ?? "write",
              linkedBy: actor,
              linkedAt: at,
            });
            events.push({
              artifactId: id,
              action: "attached",
              actor,
              summary: `attached to ${link.threadId}`,
            });
          }
        });
        const links = await writeLinksFile(this.ctx);
        await this.git.commit({
          paths: links ? [path, links] : [path],
          subject: `Create ${title}`,
          events,
          author: actor,
        });
        this.record(events, row.revision);
        return { artifact: this.summary(row), content: body, items: this.items(id, body) };
      });
    });
  }

  applyOps(
    id: string,
    ops: ReadonlyArray<LimArtifactListOp>,
    actor: LimArtifactActor,
  ): Promise<OpsResult> {
    return this.serializer.run(async () => {
      // An outside edit landing between the read and the write is reconciled
      // and the ops applied again on top of it, a few times at most.
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.applyOpsOnce(id, ops, actor);
        } catch (error) {
          if (!(error instanceof FileChangedError)) throw error;
          if (attempt >= 3) {
            throw new ArtifactStoreError(
              "unavailable",
              "the file keeps changing outside T3; try again",
            );
          }
        }
      }
    });
  }

  private async applyOpsOnce(
    id: string,
    ops: ReadonlyArray<LimArtifactListOp>,
    actor: LimArtifactActor,
  ): Promise<OpsResult> {
    {
      const row = await this.current(id);
      if (row.kind !== "md") {
        throw new ArtifactStoreError(
          "invalid_request",
          "list ops apply to markdown artifacts only",
        );
      }
      const file = this.readBody(row);
      let result: ReturnType<typeof applyListOps>;
      try {
        result = applyListOps(parseList(file.body), ops, this.random);
      } catch (error) {
        if (error instanceof ListOpError) {
          throw new ArtifactStoreError(
            error.code === "item_not_found" ? "item_not_found" : "invalid_request",
            error.message,
            row.revision,
          );
        }
        throw error;
      }
      const body = renderList(result.doc);
      if (body === file.body) {
        return { artifact: this.summary(row), items: this.items(row.id, body), itemIds: [] };
      }
      const undo = new Undo(this.root, this.index);
      undo.file(row.path);
      undo.artifact(id);
      const next = await this.writeMarkdown(
        { ...row, updatedAt: this.now().toISOString() },
        body,
        file.frontMatter?.extra,
        { size: row.size, mtime: row.mtime },
      );
      return this.undoable(undo, async () => {
        this.index.upsert(next);
        const events: ArtifactCommitEvent[] =
          result.applied.length > 0
            ? result.applied.map((applied) => ({
                artifactId: id,
                action: applied.op,
                itemId: applied.itemId,
                actor,
                summary: applied.summary,
              }))
            : [{ artifactId: id, action: "ids", actor, summary: "assigned item ids" }];
        const subject =
          events.length === 1
            ? `${actor.name} ${events[0]!.summary}`
            : `${actor.name}: ${events.length} list edits`;
        await this.git.commit({ paths: [row.path], subject, events, author: actor });
        this.record(events, next.revision);
        return {
          artifact: this.summary(next),
          items: this.items(id, body),
          itemIds: result.applied.map((applied) => applied.itemId),
        };
      });
    }
  }

  private checkThreadId(threadId: string) {
    if (!THREAD_ID.test(threadId)) {
      throw new ArtifactStoreError("invalid_request", `not a thread id: ${threadId}`);
    }
  }

  attach(
    id: string,
    threadId: string,
    access: LimArtifactLinkAccess,
    actor: LimArtifactActor,
  ): Promise<LimArtifactSummary> {
    return this.serializer.run(async () => {
      this.checkThreadId(threadId);
      const row = await this.current(id);
      const existing = this.index.links(id).find((link) => link.threadId === threadId);
      if (existing?.access === access) return this.summary(row);
      const undo = new Undo(this.root, this.index);
      undo.file(LINKS_FILE);
      undo.artifact(id);
      return this.undoable(undo, async () => {
        this.index.setLink(id, {
          threadId,
          access,
          linkedBy: existing?.linkedBy ?? actor,
          linkedAt: existing?.linkedAt ?? this.now().toISOString(),
        });
        const events: ArtifactCommitEvent[] = [
          {
            artifactId: id,
            action: "attached",
            actor,
            summary: `attached to ${threadId} (${access})`,
          },
        ];
        const links = await writeLinksFile(this.ctx);
        await this.git.commit({
          paths: links ? [links] : [],
          subject: `${actor.name} attached ${row.title} to ${threadId}`,
          events,
          author: actor,
        });
        this.record(events, row.revision);
        return this.summary(row);
      });
    });
  }

  detach(id: string, threadId: string, actor: LimArtifactActor): Promise<LimArtifactSummary> {
    return this.serializer.run(async () => {
      const row = await this.current(id);
      const undo = new Undo(this.root, this.index);
      undo.file(LINKS_FILE);
      undo.artifact(id);
      return this.undoable(undo, async () => {
        if (!this.index.removeLink(id, threadId)) {
          throw new ArtifactStoreError("not_found", `${row.title} isn't attached to ${threadId}`);
        }
        const events: ArtifactCommitEvent[] = [
          { artifactId: id, action: "detached", actor, summary: `detached from ${threadId}` },
        ];
        const links = await writeLinksFile(this.ctx);
        await this.git.commit({
          paths: links ? [links] : [],
          subject: `${actor.name} detached ${row.title} from ${threadId}`,
          events,
          author: actor,
        });
        this.record(events, row.revision);
        return this.summary(row);
      });
    });
  }
}
