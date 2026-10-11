// Fork-only (artifacts): the list editor's state, kept out of the component so
// it can be tested. The server's items are the truth; the user's ops show at once
// on top of them (optimistic) and are sent one at a time, in order, so each
// answer (the whole list after that op) replaces the server's items. A re-read
// is only applied when no op is queued and no op settled since it started, so a
// slow read can't undo an op. Changes from other writers arrive as watch frames
// and trigger a re-read; frames for this editor's own ops are recognised by
// revision and skipped.
import type {
  LimArtifactChange,
  LimArtifactItemChange,
  LimArtifactListItem,
  LimArtifactListOp,
  LimArtifactReadResponse,
  LimArtifactSummary,
} from "@t3tools/contracts";

export interface PendingOp {
  readonly key: number;
  readonly op: LimArtifactListOp;
  /** For `add`: the id the item shows under until the server names it. */
  readonly tempId: string | null;
}

export interface ListEditorState {
  readonly artifact: LimArtifactSummary | null;
  readonly content: string;
  /** The server's items, as of `artifact.revision`. */
  readonly items: ReadonlyArray<LimArtifactListItem>;
  /** Ops not answered yet, oldest first; the first is in flight once `sending` is its key. */
  readonly pending: ReadonlyArray<PendingOp>;
  readonly sending: number | null;
  readonly nextKey: number;
  /** A re-read is wanted; it starts once no op is queued and none is running. */
  readonly wantFetch: boolean;
  readonly fetching: boolean;
  /** Bumped whenever an op settles: a re-read started before then is stale. */
  readonly epoch: number;
  /** Revisions seen in watch frames while ops were queued; ours are crossed off as they settle. */
  readonly unexplained: ReadonlyArray<string>;
  readonly notice: string | null;
  /** The artifact doesn't exist (any more). */
  readonly gone: boolean;
  readonly loadError: string | null;
}

export const initialListEditorState: ListEditorState = {
  artifact: null,
  content: "",
  items: [],
  pending: [],
  sending: null,
  nextKey: 1,
  wantFetch: true,
  fetching: false,
  epoch: 0,
  unexplained: [],
  notice: null,
  gone: false,
  loadError: null,
};

/** Why an op or a read failed, as the reducer needs it. */
export interface ListEditorFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type ListEditorAction =
  | { readonly type: "enqueue"; readonly op: LimArtifactListOp }
  | { readonly type: "sending"; readonly key: number }
  | {
      readonly type: "settled";
      readonly key: number;
      readonly artifact: LimArtifactSummary;
      readonly items: ReadonlyArray<LimArtifactListItem>;
      readonly itemIds: ReadonlyArray<string>;
    }
  | { readonly type: "failed"; readonly key: number; readonly failure: ListEditorFailure }
  | { readonly type: "fetchStarted" }
  | { readonly type: "fetched"; readonly epoch: number; readonly read: LimArtifactReadResponse }
  | { readonly type: "fetchFailed"; readonly epoch: number; readonly failure: ListEditorFailure }
  /** "Give them ids" (`ops: []`) failed; it isn't a read, so the read state is left alone. */
  | { readonly type: "assignIdsFailed"; readonly failure: ListEditorFailure }
  | { readonly type: "change"; readonly change: LimArtifactChange }
  | { readonly type: "resync" }
  | { readonly type: "dismissNotice" };

export const TEMP_ID_PREFIX = "~";
export const isTempId = (id: string | null): boolean => id?.startsWith(TEMP_ID_PREFIX) ?? false;

const positionIndex = (items: ReadonlyArray<LimArtifactListItem>, at: string | undefined) => {
  if (at === "top") return 0;
  if (at?.startsWith("after:")) {
    const index = items.findIndex((item) => item.id === at.slice("after:".length));
    if (index >= 0) return index + 1;
  }
  return items.length;
};

/** One op applied locally, as the server would; an op on a missing item changes nothing. */
export function applyLocalOp(
  items: ReadonlyArray<LimArtifactListItem>,
  pending: PendingOp,
): ReadonlyArray<LimArtifactListItem> {
  const { op } = pending;
  if (op.op === "add") {
    const item: LimArtifactListItem = {
      id: pending.tempId,
      checked: false,
      text: op.text.trim(),
      tags: [],
      details: "",
      lastChange: null,
    };
    const next = [...items];
    next.splice(positionIndex(items, op.at), 0, item);
    return next;
  }
  const index = items.findIndex((item) => item.id === op.id);
  if (index < 0) return items;
  const item = items[index]!;
  const next = [...items];
  switch (op.op) {
    case "edit":
      next[index] = { ...item, text: op.text.trim() };
      return next;
    case "check":
    case "uncheck":
      next[index] = { ...item, checked: op.op === "check" };
      return next;
    case "remove":
      next.splice(index, 1);
      return next;
    case "move": {
      next.splice(index, 1);
      next.splice(positionIndex(next, op.to), 0, item);
      return next;
    }
  }
}

/** What the editor shows: the server's items with the queued ops on top. */
export const visibleItems = (state: ListEditorState): ReadonlyArray<LimArtifactListItem> =>
  state.pending.reduce(applyLocalOp, state.items);

/** The queued op to send next, if none is running. */
export const nextToSend = (state: ListEditorState): PendingOp | null =>
  state.sending === null && !state.gone ? (state.pending[0] ?? null) : null;

/** Whether to start a re-read now. */
export const shouldFetch = (state: ListEditorState): boolean =>
  state.wantFetch && !state.fetching && state.pending.length === 0 && !state.gone;

const refersTo = (op: LimArtifactListOp, id: string): boolean =>
  ("id" in op && op.id === id) ||
  (op.op === "add" && op.at === `after:${id}`) ||
  (op.op === "move" && op.to === `after:${id}`);

const renameIn = (op: LimArtifactListOp, from: string, to: string): LimArtifactListOp => {
  const after = (position: string | undefined) =>
    position === `after:${from}` ? `after:${to}` : position;
  switch (op.op) {
    case "add": {
      const at = after(op.at);
      return at === undefined ? { op: "add", text: op.text } : { ...op, at };
    }
    case "move":
      return { ...op, id: op.id === from ? to : op.id, to: after(op.to)! };
    default:
      return op.id === from ? { ...op, id: to } : op;
  }
};

/** Drains the queue: anything seen meanwhile that wasn't ours means a re-read. */
const afterDrain = (state: ListEditorState): ListEditorState =>
  state.pending.length > 0
    ? state
    : {
        ...state,
        wantFetch: state.wantFetch || state.unexplained.length > 0,
        unexplained: [],
      };

const describe = (failure: ListEditorFailure): string =>
  failure.code === "item_not_found"
    ? "Someone else removed or changed that item first. The list is up to date again."
    : failure.message;

export function listEditorReducer(
  state: ListEditorState,
  action: ListEditorAction,
): ListEditorState {
  switch (action.type) {
    case "enqueue": {
      const key = state.nextKey;
      const tempId = action.op.op === "add" ? `${TEMP_ID_PREFIX}${key}` : null;
      return {
        ...state,
        pending: [...state.pending, { key, op: action.op, tempId }],
        nextKey: key + 1,
        notice: null,
      };
    }
    case "sending":
      return state.pending[0]?.key === action.key ? { ...state, sending: action.key } : state;
    case "settled": {
      const [head, ...rest] = state.pending;
      if (!head || head.key !== action.key) return state;
      const realId = action.itemIds[0];
      const pending =
        head.tempId !== null && realId !== undefined
          ? rest.map((queued) => ({ ...queued, op: renameIn(queued.op, head.tempId!, realId) }))
          : rest;
      // The answer has items but no body. Once the list is empty the last read's
      // body (shown as plain text then) still has the old items: drop it and re-read.
      const base: ListEditorState = {
        ...state,
        artifact: action.artifact,
        items: action.items,
        pending,
        sending: null,
        epoch: state.epoch + 1,
        unexplained: state.unexplained.filter((revision) => revision !== action.artifact.revision),
        content: action.items.length === 0 ? "" : state.content,
        wantFetch: state.wantFetch || action.items.length === 0,
      };
      return afterDrain(base);
    }
    case "failed": {
      const [head, ...rest] = state.pending;
      if (!head || head.key !== action.key) return state;
      // An add that failed takes the ops on its item with it.
      const pending =
        head.tempId !== null ? rest.filter((queued) => !refersTo(queued.op, head.tempId!)) : rest;
      return afterDrain({
        ...state,
        pending,
        sending: null,
        epoch: state.epoch + 1,
        wantFetch: true,
        gone: state.gone || action.failure.code === "not_found",
        notice: describe(action.failure),
      });
    }
    case "fetchStarted":
      return { ...state, wantFetch: false, fetching: true };
    case "fetched": {
      // Ops queued or settled since the read started may be missing from it.
      if (state.pending.length > 0 || action.epoch !== state.epoch) {
        return { ...state, fetching: false, wantFetch: true };
      }
      return {
        ...state,
        fetching: false,
        artifact: action.read.artifact,
        content: action.read.content,
        items: action.read.items,
        loadError: null,
      };
    }
    case "fetchFailed": {
      // Like a stale read: a failure from before an op settled (say a 404 for an
      // artifact the op answers for) mustn't replace the list; read again instead.
      if (state.pending.length > 0 || action.epoch !== state.epoch) {
        return { ...state, fetching: false, wantFetch: true };
      }
      return {
        ...state,
        fetching: false,
        gone: action.failure.code === "not_found",
        loadError: action.failure.message,
      };
    }
    case "assignIdsFailed":
      return { ...state, wantFetch: true, notice: describe(action.failure) };
    case "change": {
      const { revision } = action.change;
      // Our own op's frame, after its answer already updated the list.
      if (revision !== null && revision === state.artifact?.revision) return state;
      if (state.pending.length > 0) {
        return revision === null
          ? { ...state, wantFetch: true }
          : { ...state, unexplained: [...state.unexplained, revision] };
      }
      return { ...state, wantFetch: true };
    }
    case "resync":
      return { ...state, wantFetch: true };
    case "dismissNotice":
      return { ...state, notice: null, loadError: null };
  }
}

/**
 * Where a drag from `fromIndex` to `toIndex` puts the item, as a move op's `to`:
 * `top`, or after the nearest item above it that has an id.
 */
export function moveTarget(
  items: ReadonlyArray<LimArtifactListItem>,
  fromIndex: number,
  toIndex: number,
): string | null {
  if (fromIndex === toIndex || !items[fromIndex] || !items[toIndex]) return null;
  const duplicates = duplicateItemIds(items);
  const order = [...items];
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved!);
  for (let index = toIndex - 1; index >= 0; index--) {
    const id = order[index]!.id;
    if (id !== null && !duplicates.has(id)) return `after:${id}`;
  }
  return "top";
}

/** Ids on more than one item (a line copied outside T3); an op can't tell those items apart. */
export function duplicateItemIds(items: ReadonlyArray<LimArtifactListItem>): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (item.id === null) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return duplicates;
}

export interface ItemRow {
  readonly item: LimArtifactListItem;
  /** Unique among the rows: the React key and the drag id. */
  readonly key: string;
  /** Ops need the item's own id; items with none, or a shared one, wait for "Give them ids". */
  readonly ownId: boolean;
  /** Has its own id, and the session may write (`orchestration:operate`). */
  readonly editable: boolean;
}

/** `canWrite`: the session has `orchestration:operate`; without it every op is a 403. */
export function itemRows(
  items: ReadonlyArray<LimArtifactListItem>,
  canWrite: boolean,
): ReadonlyArray<ItemRow> {
  const duplicates = duplicateItemIds(items);
  return items.map((item, index) => {
    const ownId = item.id !== null && !duplicates.has(item.id);
    return { item, key: ownId ? item.id! : `row:${index}`, ownId, editable: ownId && canWrite };
  });
}

/** "Give them ids" is a write too, so a read-only session isn't offered it. */
export function needsIds(rows: ReadonlyArray<ItemRow>, canWrite: boolean): boolean {
  return canWrite && rows.some((row) => !row.ownId);
}

/**
 * The file's body, shown as plain text when the server's list has no items
 * (not when the shown list is empty only because a removal is still on its
 * way: the body would bring that item back).
 */
export const plainContent = (state: ListEditorState): string | null =>
  state.items.length === 0 && state.content.trim() ? state.content : null;

const VERBS: Record<string, string> = {
  add: "added",
  edit: "edited",
  check: "checked",
  uncheck: "unchecked",
  move: "moved",
};

/** "Alder checked", for the last change shown beside an item. */
export const lastChangeLabel = (change: LimArtifactItemChange): string =>
  `${change.actor.name} ${VERBS[change.action] ?? change.action}`;

/** The New list dialog's items, one per line, as the list's markdown body. */
export function initialListContent(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*+]\s+\[[ xX]\]\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
  return lines.map((line) => `- [ ] ${line}\n`).join("");
}

/** Threads the dialog offers to attach: this environment's live threads, newest first. */
export function attachCandidates<
  T extends {
    readonly id: string;
    readonly environmentId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  },
>(threads: ReadonlyArray<T>, environmentId: string, query: string, limit = 50): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        (needle === "" || thread.title.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
