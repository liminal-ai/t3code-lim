// Fork-only (artifacts): the store's index, its own node:sqlite file at
// `.t3/index.sqlite` (never statev2, whose migrator would skip a fork
// migration id and block upstream's next one). Everything in it is rebuildable
// from the files, `.t3-meta/links.json` and the commit log, so a schema change
// drops and rebuilds it instead of migrating.
import * as NodeSqlite from "node:sqlite";

import type {
  LimArtifactActor,
  LimArtifactKind,
  LimArtifactLink,
  LimArtifactLinkAccess,
  LimArtifactState,
} from "@t3tools/contracts";

export const INDEX_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  created_by_kind TEXT,
  created_by_id TEXT,
  created_by_name TEXT,
  kept_by_kind TEXT,
  kept_by_id TEXT,
  kept_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  content_hash TEXT NOT NULL,
  expires_at TEXT,
  body_text TEXT NOT NULL DEFAULT ''
);
CREATE TABLE artifact_tags (
  artifact_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (artifact_id, tag)
);
CREATE TABLE artifact_links (
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  access TEXT NOT NULL,
  linked_by_kind TEXT NOT NULL,
  linked_by_id TEXT NOT NULL,
  linked_by_name TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, thread_id)
);
CREATE INDEX artifact_links_thread ON artifact_links (thread_id);
CREATE TABLE artifact_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id TEXT,
  summary TEXT NOT NULL,
  revision TEXT
);
CREATE INDEX artifact_events_artifact ON artifact_events (artifact_id, seq);
CREATE TABLE publications (
  artifact_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  revision TEXT NOT NULL,
  published_at TEXT NOT NULL
);
`;

export interface ArtifactRow {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly kind: LimArtifactKind;
  readonly state: LimArtifactState;
  readonly createdBy: LimArtifactActor | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: string;
  readonly size: number;
  readonly mtime: number;
  readonly bodyText: string;
  readonly tags: ReadonlyArray<string>;
}

export interface ArtifactEventRow {
  readonly seq: number;
  readonly artifactId: string;
  readonly at: string;
  readonly actor: LimArtifactActor;
  readonly action: string;
  readonly itemId: string | null;
  readonly summary: string;
  readonly revision: string | null;
}

export interface ListFilter {
  readonly threadId?: string | undefined;
  readonly tag?: string | undefined;
  readonly folder?: string | undefined;
  readonly kind?: LimArtifactKind | undefined;
  readonly query?: string | undefined;
}

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const str = (value: NodeSqlite.SQLOutputValue) => (value == null ? null : String(value));

const actorOf = (kind: unknown, id: unknown, name: unknown): LimArtifactActor | null =>
  typeof kind === "string" && typeof id === "string"
    ? {
        kind: kind as LimArtifactActor["kind"],
        id,
        name: typeof name === "string" ? name : id,
      }
    : null;

const toEvent = (row: Row): ArtifactEventRow => ({
  seq: Number(row.seq),
  artifactId: String(row.artifact_id),
  at: String(row.at),
  actor: actorOf(row.actor_kind, row.actor_id, row.actor_name)!,
  action: String(row.action),
  itemId: str(row.item_id),
  summary: String(row.summary),
  revision: str(row.revision),
});

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export class ArtifactIndex {
  private readonly db: NodeSqlite.DatabaseSync;
  /** True when the index was created empty (missing, unreadable or an old schema). */
  readonly created: boolean;

  private constructor(db: NodeSqlite.DatabaseSync, created: boolean) {
    this.db = db;
    this.created = created;
  }

  /** Opens the index, recreating it when missing, unreadable or on another schema version. */
  static open(file: string, remove: (file: string) => void): ArtifactIndex {
    const existing = ArtifactIndex.tryOpenExisting(file, remove);
    if (existing) return new ArtifactIndex(existing, false);
    const db = new NodeSqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(INDEX_SCHEMA_VERSION);
    db.exec("COMMIT");
    return new ArtifactIndex(db, true);
  }

  private static tryOpenExisting(file: string, remove: (file: string) => void) {
    let db: NodeSqlite.DatabaseSync | undefined;
    try {
      db = new NodeSqlite.DatabaseSync(file, { open: true });
      const row = db.prepare("SELECT version FROM schema_version").get() as Row | undefined;
      if (row && Number(row.version) === INDEX_SCHEMA_VERSION) return db;
    } catch {
      // Missing table or unreadable file: rebuild below.
    }
    db?.close();
    for (const suffix of ["", "-wal", "-shm"]) remove(`${file}${suffix}`);
    return undefined;
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private toArtifact(row: Row): ArtifactRow {
    const tags = (
      this.db
        .prepare("SELECT tag FROM artifact_tags WHERE artifact_id = ? ORDER BY tag")
        .all(row.id as string) as Row[]
    ).map((tag) => String(tag.tag));
    return {
      id: String(row.id),
      path: String(row.path),
      title: String(row.title),
      kind: String(row.kind) as LimArtifactKind,
      state: String(row.state) as LimArtifactState,
      createdBy: actorOf(row.created_by_kind, row.created_by_id, row.created_by_name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: String(row.revision),
      size: Number(row.size),
      mtime: Number(row.mtime),
      bodyText: String(row.body_text ?? ""),
      tags,
    };
  }

  get(id: string): ArtifactRow | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toArtifact(row) : undefined;
  }

  getByPath(path: string): ArtifactRow | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(path) as
      | Row
      | undefined;
    return row ? this.toArtifact(row) : undefined;
  }

  all(): ArtifactRow[] {
    return (this.db.prepare("SELECT * FROM artifacts ORDER BY path").all() as Row[]).map((row) =>
      this.toArtifact(row),
    );
  }

  list(filter: ListFilter): ArtifactRow[] {
    const where: string[] = ["state = 'kept'"];
    const params: NodeSqlite.SQLInputValue[] = [];
    if (filter.threadId) {
      where.push("id IN (SELECT artifact_id FROM artifact_links WHERE thread_id = ?)");
      params.push(filter.threadId);
    }
    if (filter.tag) {
      where.push("id IN (SELECT artifact_id FROM artifact_tags WHERE tag = ?)");
      params.push(filter.tag);
    }
    if (filter.folder) {
      where.push("path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(filter.folder.replace(/\/+$/, ""))}/%`);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.query) {
      where.push(
        "(title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\')",
      );
      const like = `%${escapeLike(filter.query)}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM artifacts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, path`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.toArtifact(row));
  }

  upsert(artifact: ArtifactRow) {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, path, title, kind, state, created_by_kind, created_by_id,
           created_by_name, created_at, updated_at, revision, size, mtime, content_hash, body_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET path = excluded.path, title = excluded.title,
           kind = excluded.kind, state = excluded.state, updated_at = excluded.updated_at,
           revision = excluded.revision, size = excluded.size, mtime = excluded.mtime,
           content_hash = excluded.content_hash, body_text = excluded.body_text`,
      )
      .run(
        artifact.id,
        artifact.path,
        artifact.title,
        artifact.kind,
        artifact.state,
        artifact.createdBy?.kind ?? null,
        artifact.createdBy?.id ?? null,
        artifact.createdBy?.name ?? null,
        artifact.createdAt,
        artifact.updatedAt,
        artifact.revision,
        artifact.size,
        artifact.mtime,
        artifact.revision,
        artifact.bodyText,
      );
    this.db.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?").run(artifact.id);
    const insertTag = this.db.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)");
    for (const tag of new Set(artifact.tags)) insertTag.run(artifact.id, tag);
  }

  /** Sets who created an artifact and when (rebuild from the commit log). */
  setCreated(id: string, createdBy: LimArtifactActor, createdAt: string) {
    this.db
      .prepare(
        `UPDATE artifacts SET created_by_kind = ?, created_by_id = ?, created_by_name = ?,
           created_at = ? WHERE id = ?`,
      )
      .run(createdBy.kind, createdBy.id, createdBy.name, createdAt, id);
  }

  setUpdatedAt(id: string, updatedAt: string) {
    this.db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  remove(id: string) {
    for (const table of ["artifacts", "artifact_tags", "artifact_links"]) {
      const column = table === "artifacts" ? "id" : "artifact_id";
      this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
    }
  }

  links(id: string): LimArtifactLink[] {
    return (
      this.db
        .prepare("SELECT * FROM artifact_links WHERE artifact_id = ? ORDER BY linked_at, thread_id")
        .all(id) as Row[]
    ).map((row) => ({
      threadId: String(row.thread_id),
      access: String(row.access) as LimArtifactLinkAccess,
      linkedBy: actorOf(row.linked_by_kind, row.linked_by_id, row.linked_by_name)!,
      linkedAt: String(row.linked_at),
    }));
  }

  allLinks(): Map<string, LimArtifactLink[]> {
    const byArtifact = new Map<string, LimArtifactLink[]>();
    for (const row of this.db
      .prepare("SELECT artifact_id FROM artifact_links GROUP BY artifact_id")
      .all() as Row[]) {
      const id = String(row.artifact_id);
      byArtifact.set(id, this.links(id));
    }
    return byArtifact;
  }

  setLink(id: string, link: LimArtifactLink) {
    this.db
      .prepare(
        `INSERT INTO artifact_links (artifact_id, thread_id, access, linked_by_kind, linked_by_id,
           linked_by_name, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (artifact_id, thread_id) DO UPDATE SET access = excluded.access`,
      )
      .run(
        id,
        link.threadId,
        link.access,
        link.linkedBy.kind,
        link.linkedBy.id,
        link.linkedBy.name,
        link.linkedAt,
      );
  }

  removeLink(id: string, threadId: string) {
    return (
      this.db
        .prepare("DELETE FROM artifact_links WHERE artifact_id = ? AND thread_id = ?")
        .run(id, threadId).changes > 0
    );
  }

  addEvent(event: Omit<ArtifactEventRow, "seq">): ArtifactEventRow {
    const result = this.db
      .prepare(
        `INSERT INTO artifact_events (artifact_id, at, actor_kind, actor_id, actor_name, action,
           item_id, summary, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.artifactId,
        event.at,
        event.actor.kind,
        event.actor.id,
        event.actor.name,
        event.action,
        event.itemId,
        event.summary,
        event.revision,
      );
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM artifact_events").get() as Row;
    return row.seq == null ? 0 : Number(row.seq);
  }

  /** The last event per list item of one artifact. */
  lastItemEvents(id: string): Map<string, ArtifactEventRow> {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifact_events WHERE artifact_id = ? AND item_id IS NOT NULL
         AND seq IN (SELECT MAX(seq) FROM artifact_events WHERE artifact_id = ?
           AND item_id IS NOT NULL GROUP BY item_id)`,
      )
      .all(id, id) as Row[];
    return new Map(rows.map((row) => [String(row.item_id), toEvent(row)]));
  }
}
