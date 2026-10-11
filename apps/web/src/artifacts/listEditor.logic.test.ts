import type {
  LimArtifactActor,
  LimArtifactChange,
  LimArtifactListItem,
  LimArtifactReadResponse,
  LimArtifactSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ListEditorAction,
  type ListEditorState,
  attachCandidates,
  initialListContent,
  initialListEditorState,
  itemRows,
  lastChangeLabel,
  listEditorReducer,
  moveTarget,
  nextToSend,
  plainContent,
  shouldFetch,
  visibleItems,
} from "./listEditor.logic";

const alder: LimArtifactActor = { kind: "agent", id: "thread-alder", name: "Alder" };

const item = (id: string | null, text: string, checked = false): LimArtifactListItem => ({
  id,
  checked,
  text,
  tags: [],
  details: "",
  lastChange: null,
});

const summary = (revision: string): LimArtifactSummary => ({
  id: "01JA7Q3F2M0000000000000000",
  path: "t3/backlog.md",
  absolutePath: "/store/t3/backlog.md",
  title: "T3 backlog",
  kind: "md",
  state: "kept",
  tags: [],
  revision,
  size: 1,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  createdBy: null,
  links: [],
});

const read = (revision: string, items: LimArtifactListItem[]): LimArtifactReadResponse => ({
  store: { environmentId: "env", environmentName: "lim-builder", storeDir: "/store" },
  artifact: summary(revision),
  content: "",
  items,
});

const change = (revision: string | null): LimArtifactChange => ({
  seq: 1,
  artifactId: summary("r").id,
  at: "2026-10-10T00:00:00.000Z",
  action: "check",
  actor: alder,
  summary: "checked",
  itemId: "b3",
  revision,
});

const run = (state: ListEditorState, ...actions: ListEditorAction[]) =>
  actions.reduce(listEditorReducer, state);

/** A loaded editor at revision r1 with three items. */
const loaded = run(
  initialListEditorState,
  { type: "fetchStarted" },
  {
    type: "fetched",
    epoch: 0,
    read: read("r1", [item("a1", "First"), item("b2", "Second"), item("c3", "Third", true)]),
  },
);

const texts = (state: ListEditorState) => visibleItems(state).map((i) => i.text);

describe("optimistic ops", () => {
  it("shows a queued op at once, before the server answers", () => {
    const state = run(loaded, { type: "enqueue", op: { op: "check", id: "a1" } });
    expect(visibleItems(state)[0]?.checked).toBe(true);
    expect(state.items[0]?.checked).toBe(false);
  });

  it("applies each op kind locally as the server would", () => {
    const state = run(
      loaded,
      { type: "enqueue", op: { op: "add", text: "  New top  ", at: "top" } },
      { type: "enqueue", op: { op: "edit", id: "b2", text: "Second, edited" } },
      { type: "enqueue", op: { op: "uncheck", id: "c3" } },
      { type: "enqueue", op: { op: "move", id: "a1", to: "after:c3" } },
      { type: "enqueue", op: { op: "remove", id: "zz" } },
    );
    expect(texts(state)).toEqual(["New top", "Second, edited", "Third", "First"]);
    expect(visibleItems(state)[2]?.checked).toBe(false);
  });

  it("sends one op at a time, oldest first", () => {
    let state = run(
      loaded,
      { type: "enqueue", op: { op: "check", id: "a1" } },
      { type: "enqueue", op: { op: "check", id: "b2" } },
    );
    const first = nextToSend(state);
    expect(first?.op).toEqual({ op: "check", id: "a1" });
    state = run(state, { type: "sending", key: first!.key });
    expect(nextToSend(state)).toBeNull();
    state = run(state, {
      type: "settled",
      key: first!.key,
      artifact: summary("r2"),
      items: [item("a1", "First", true), item("b2", "Second"), item("c3", "Third", true)],
      itemIds: ["a1"],
    });
    expect(nextToSend(state)?.op).toEqual({ op: "check", id: "b2" });
    // The answer is the base now, with the remaining op still shown on top.
    expect(state.items[0]?.checked).toBe(true);
    expect(visibleItems(state)[1]?.checked).toBe(true);
  });

  it("renames a new item's temporary id in later ops once the server names it", () => {
    let state = run(loaded, { type: "enqueue", op: { op: "add", text: "Fresh" } });
    const tempId = state.pending[0]!.tempId!;
    state = run(
      state,
      { type: "enqueue", op: { op: "check", id: tempId } },
      { type: "enqueue", op: { op: "move", id: "a1", to: `after:${tempId}` } },
    );
    expect(visibleItems(state).find((i) => i.text === "Fresh")?.checked).toBe(true);
    const add = state.pending[0]!;
    state = run(
      state,
      { type: "sending", key: add.key },
      {
        type: "settled",
        key: add.key,
        artifact: summary("r2"),
        items: [...loaded.items, item("d4", "Fresh")],
        itemIds: ["d4"],
      },
    );
    expect(state.pending.map((p) => p.op)).toEqual([
      { op: "check", id: "d4" },
      { op: "move", id: "a1", to: "after:d4" },
    ]);
  });

  it("drops the ops on a new item when its add fails", () => {
    let state = run(loaded, { type: "enqueue", op: { op: "add", text: "Doomed" } });
    const add = state.pending[0]!;
    state = run(
      state,
      { type: "enqueue", op: { op: "check", id: add.tempId! } },
      { type: "enqueue", op: { op: "check", id: "b2" } },
      { type: "sending", key: add.key },
      {
        type: "failed",
        key: add.key,
        failure: { status: 400, code: "invalid_op", message: "item text is empty" },
      },
    );
    expect(state.pending.map((p) => p.op)).toEqual([{ op: "check", id: "b2" }]);
    expect(texts(state)).not.toContain("Doomed");
  });
});

describe("an op on an item someone else removed", () => {
  const failed = (() => {
    const state = run(loaded, { type: "enqueue", op: { op: "check", id: "b2" } });
    const key = state.pending[0]!.key;
    return run(
      state,
      { type: "sending", key },
      {
        type: "failed",
        key,
        failure: { status: 404, code: "item_not_found", message: "no item ^b2 in this list" },
      },
    );
  })();

  it("rolls the optimistic change back and says so plainly", () => {
    expect(failed.pending).toEqual([]);
    expect(visibleItems(failed)[1]?.checked).toBe(false);
    expect(failed.notice).toMatch(/Someone else removed or changed that item/);
  });

  it("re-reads the list, and the next op clears the notice", () => {
    expect(shouldFetch(failed)).toBe(true);
    expect(failed.gone).toBe(false);
    expect(run(failed, { type: "enqueue", op: { op: "check", id: "a1" } }).notice).toBeNull();
  });

  it("marks the artifact gone when the whole artifact was removed", () => {
    const state = run(loaded, { type: "enqueue", op: { op: "check", id: "a1" } });
    const key = state.pending[0]!.key;
    const gone = run(state, {
      type: "failed",
      key,
      failure: { status: 404, code: "not_found", message: "no such artifact" },
    });
    expect(gone.gone).toBe(true);
    expect(shouldFetch(gone)).toBe(false);
  });
});

describe("re-reads and watch frames", () => {
  it("re-reads on another writer's change, but not on the frame for its own op", () => {
    expect(shouldFetch(run(loaded, { type: "change", change: change("r9") }))).toBe(true);
    expect(shouldFetch(run(loaded, { type: "change", change: change("r1") }))).toBe(false);
    expect(shouldFetch(run(loaded, { type: "resync" }))).toBe(true);
  });

  it("waits for queued ops before re-reading", () => {
    const state = run(
      loaded,
      { type: "enqueue", op: { op: "check", id: "a1" } },
      { type: "resync" },
    );
    expect(shouldFetch(state)).toBe(false);
    const key = state.pending[0]!.key;
    const drained = run(
      state,
      { type: "sending", key },
      { type: "settled", key, artifact: summary("r2"), items: loaded.items, itemIds: ["a1"] },
    );
    expect(shouldFetch(drained)).toBe(true);
  });

  it("skips a re-read when every frame seen during the ops was one of its own", () => {
    let state = run(loaded, { type: "enqueue", op: { op: "check", id: "a1" } });
    const key = state.pending[0]!.key;
    // The stream can beat the HTTP answer.
    state = run(
      state,
      { type: "sending", key },
      { type: "change", change: change("r2") },
      { type: "settled", key, artifact: summary("r2"), items: loaded.items, itemIds: ["a1"] },
    );
    expect(shouldFetch(state)).toBe(false);
  });

  it("re-reads after the ops when a frame during them was someone else's", () => {
    let state = run(loaded, { type: "enqueue", op: { op: "check", id: "a1" } });
    const key = state.pending[0]!.key;
    state = run(
      state,
      { type: "sending", key },
      { type: "change", change: change("other") },
      { type: "settled", key, artifact: summary("r2"), items: loaded.items, itemIds: ["a1"] },
    );
    expect(shouldFetch(state)).toBe(true);
  });

  it("drops a read that started before an op settled, and reads again", () => {
    let state = run(loaded, { type: "resync" }, { type: "fetchStarted" });
    const startedAt = state.epoch;
    state = run(state, { type: "enqueue", op: { op: "check", id: "a1" } });
    const key = state.pending[0]!.key;
    state = run(
      state,
      { type: "sending", key },
      {
        type: "settled",
        key,
        artifact: summary("r2"),
        items: [item("a1", "First", true), ...loaded.items.slice(1)],
        itemIds: ["a1"],
      },
      // The slow read answers with the list from before the op.
      { type: "fetched", epoch: startedAt, read: read("r1", [...loaded.items]) },
    );
    expect(state.artifact?.revision).toBe("r2");
    expect(state.items[0]?.checked).toBe(true);
    expect(shouldFetch(state)).toBe(true);
  });

  it("applies a read that nothing overtook", () => {
    const state = run(loaded, { type: "resync" }, { type: "fetchStarted" });
    const next = run(state, {
      type: "fetched",
      epoch: state.epoch,
      read: read("r5", [item("x1", "Only")]),
    });
    expect(texts(next)).toEqual(["Only"]);
    expect(next.artifact?.revision).toBe("r5");
  });
});

describe("review fixes (PR 3 round 1)", () => {
  const withBody = (body: string, items: LimArtifactListItem[]) =>
    run(
      initialListEditorState,
      { type: "fetchStarted" },
      { type: "fetched", epoch: 0, read: { ...read("r1", items), content: body } },
    );

  it("doesn't show the old body again once the last item is removed", () => {
    let state = withBody("- [ ] Only ^a1\n", [item("a1", "Only")]);
    state = run(state, { type: "enqueue", op: { op: "remove", id: "a1" } });
    // Optimistically empty, but the server hasn't answered: no plain-text fallback.
    expect(plainContent(state)).toBeNull();
    const key = state.pending[0]!.key;
    state = run(
      state,
      { type: "sending", key },
      { type: "settled", key, artifact: summary("r2"), items: [], itemIds: ["a1"] },
    );
    expect(plainContent(state)).toBeNull();
    // Its own frame doesn't trigger a re-read, so the empty answer has to ask for one.
    expect(shouldFetch(run(state, { type: "change", change: change("r2") }))).toBe(true);
  });

  it("shows a body without checklist items as plain text", () => {
    expect(plainContent(withBody("Notes only\n", []))).toBe("Notes only\n");
  });

  it("ignores a read failure from before an op settled, and reads again", () => {
    let state = run(loaded, { type: "resync" }, { type: "fetchStarted" });
    const startedAt = state.epoch;
    state = run(state, { type: "enqueue", op: { op: "check", id: "a1" } });
    const key = state.pending[0]!.key;
    state = run(
      state,
      { type: "sending", key },
      { type: "settled", key, artifact: summary("r2"), items: loaded.items, itemIds: ["a1"] },
      {
        type: "fetchFailed",
        epoch: startedAt,
        failure: { status: 404, code: "not_found", message: "no such artifact" },
      },
    );
    expect(state.gone).toBe(false);
    expect(state.loadError).toBeNull();
    expect(state.items).toEqual(loaded.items);
    expect(shouldFetch(state)).toBe(true);
  });

  it("reports a current read failure", () => {
    const state = run(loaded, { type: "resync" }, { type: "fetchStarted" });
    const failed = run(state, {
      type: "fetchFailed",
      epoch: state.epoch,
      failure: { status: 0, code: "network", message: "couldn't reach the T3 server" },
    });
    expect(failed.loadError).toBe("couldn't reach the T3 server");
    expect(failed.fetching).toBe(false);
  });

  it("a failed 'Give them ids' leaves a running read alone", () => {
    const state = run(loaded, { type: "resync" }, { type: "fetchStarted" });
    const failed = run(state, {
      type: "assignIdsFailed",
      failure: { status: 503, code: "unavailable", message: "store down" },
    });
    expect(failed.fetching).toBe(true);
    expect(failed.notice).toBe("store down");
  });
});

describe("duplicate item ids", () => {
  // An outside copy of a line gives two rows ^b2.
  const items = [
    item("a1", "A"),
    item("b2", "B"),
    item("b2", "B copy"),
    item(null, "C"),
    item("d4", "D"),
  ];

  it("disables rows that share an id, like rows without one, with unique keys", () => {
    const rows = itemRows(items);
    expect(rows.map((row) => row.editable)).toEqual([true, false, false, false, true]);
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never moves an item after a shared id", () => {
    // D dropped just below "B copy" goes after A, the nearest item with its own id.
    expect(moveTarget(items, 4, 3)).toBe("after:a1");
  });
});

describe("moveTarget", () => {
  const items = [item("a1", "A"), item("b2", "B"), item("c3", "C"), item("d4", "D")];

  it("moves to the top, or after the item that ends up above", () => {
    expect(moveTarget(items, 2, 0)).toBe("top");
    expect(moveTarget(items, 0, 2)).toBe("after:c3");
    expect(moveTarget(items, 3, 1)).toBe("after:a1");
    expect(moveTarget(items, 1, 1)).toBeNull();
  });

  it("skips items above that have no id yet", () => {
    const mixed = [item("a1", "A"), item(null, "B"), item("c3", "C"), item("d4", "D")];
    // D dropped just below B (which has no id) goes after A.
    expect(moveTarget(mixed, 3, 2)).toBe("after:a1");
    // A dropped below B has no item with an id above it.
    expect(moveTarget(mixed, 0, 1)).toBe("top");
  });
});

describe("dialog and labels", () => {
  it("turns one item per line into checklist markdown", () => {
    expect(initialListContent("First\n\n  - [x] Second \n* Third\n")).toBe(
      "- [ ] First\n- [ ] Second\n- [ ] Third\n",
    );
    expect(initialListContent("  \n")).toBe("");
  });

  it("names who made the last change", () => {
    expect(lastChangeLabel({ at: "2026-10-10T00:00:00Z", action: "check", actor: alder })).toBe(
      "Alder checked",
    );
  });

  it("offers this environment's live threads, newest first, filtered by title", () => {
    const thread = (id: string, environmentId: string, title: string, updatedAt: string) => ({
      id,
      environmentId,
      title,
      updatedAt,
      archivedAt: null as string | null,
    });
    const threads = [
      thread("t1", "env", "Mira backlog", "2026-10-01"),
      thread("t2", "env", "Alder", "2026-10-03"),
      thread("t3", "other", "Mira elsewhere", "2026-10-04"),
      { ...thread("t4", "env", "Mira archived", "2026-10-05"), archivedAt: "2026-10-06" },
    ];
    expect(attachCandidates(threads, "env", "").map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(attachCandidates(threads, "env", "mira").map((t) => t.id)).toEqual(["t1"]);
  });
});
