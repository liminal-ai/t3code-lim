import { describe, expect, it } from "vite-plus/test";

import {
  applyListOps,
  assignItemIds,
  inlineTags,
  ListOpError,
  listItems,
  newItemId,
  parseList,
  renderList,
} from "./listOps.ts";

/** Deterministic ids: a fixed sequence of base36 digits. */
const sequence = (...digits: number[]) => {
  let index = 0;
  return () => (digits[index++ % digits.length]! + 0.5) / 36;
};

const BODY = `# Backlog

Some notes up top.

- [ ] Fix pinned sort ^b7
  - sub note
- [x] Ship compact chip ^c2
- [ ] No id yet

Trailing prose.
`;

describe("parseList / renderList", () => {
  it("round-trips a file with prose, details and ids", () => {
    expect(renderList(parseList(BODY))).toBe(BODY);
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    const crlf = "- [ ] one ^aa\r\n- [x] two ^bb";
    expect(renderList(parseList(crlf))).toBe(crlf);
  });

  it("reads items, ids, checked state and details", () => {
    const items = listItems(parseList(BODY));
    expect(items.map((item) => [item.id, item.checked, item.text])).toEqual([
      ["b7", false, "Fix pinned sort"],
      ["c2", true, "Ship compact chip"],
      [null, false, "No id yet"],
    ]);
    expect(items[0]!.details).toEqual(["  - sub note"]);
  });

  it("only counts top-level checklist lines as items", () => {
    const items = listItems(parseList("  - [ ] nested\n- plain bullet\n* [X] star ^zz\n"));
    expect(items.map((item) => [item.marker, item.checked, item.id])).toEqual([["*", true, "zz"]]);
  });
});

describe("item ids", () => {
  it("assigns missing ids and replaces duplicates, keeping the first", () => {
    const doc = assignItemIds(
      parseList("- [ ] a ^aa\n- [ ] b ^aa\n- [ ] c\n"),
      sequence(1, 2, 3, 4),
    );
    const ids = listItems(doc).map((item) => item.id);
    expect(ids[0]).toBe("aa");
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^[a-z0-9]{2,4}$/.test(id!))).toBe(true);
  });

  it("grows past two characters when two-character ids collide", () => {
    const used = new Set(["11"]);
    expect(newItemId(used, sequence(1))).toBe("111");
  });

  it("reads inline #tags", () => {
    expect(inlineTags("fix sort #t3 #ui/sidebar and #t3")).toEqual(["t3", "ui/sidebar"]);
  });
});

describe("applyListOps", () => {
  const ids = (body: string) => listItems(parseList(body)).map((item) => item.id);

  it("adds at the bottom by default, at the top, and after an item", () => {
    const random = sequence(10, 11, 12, 13, 14, 15, 16, 17);
    const base = parseList("- [ ] a ^aa\n- [ ] b ^bb\n");
    const { doc, applied } = applyListOps(
      base,
      [
        { op: "add", text: "last" },
        { op: "add", text: "first", at: "top" },
        { op: "add", text: "middle", at: "after:aa" },
      ],
      random,
    );
    const texts = listItems(doc).map((item) => item.text);
    expect(texts).toEqual(["first", "a", "middle", "b", "last"]);
    expect(applied.map((op) => op.op)).toEqual(["add", "add", "add"]);
    expect(new Set(listItems(doc).map((item) => item.id)).size).toBe(5);
  });

  it("separates a new item from prose with a blank line", () => {
    const { doc } = applyListOps(parseList("# Title\n"), [{ op: "add", text: "one" }], sequence(5));
    expect(renderList(doc)).toMatch(/^# Title\n\n- \[ \] one \^[a-z0-9]{2}\n$/);
  });

  it("edits, checks, unchecks, moves and removes by id", () => {
    const start = "- [ ] a ^aa\n  detail\n- [ ] b ^bb\n- [x] c ^cc\n";
    const { doc } = applyListOps(parseList(start), [
      { op: "edit", id: "aa", text: "a2 #t3" },
      { op: "check", id: "bb" },
      { op: "uncheck", id: "cc" },
      { op: "move", id: "aa", to: "bottom" },
      { op: "remove", id: "bb" },
    ]);
    expect(renderList(doc)).toBe("- [ ] c ^cc\n- [ ] a2 #t3 ^aa\n  detail\n");
  });

  it("moves to the top and after another item", () => {
    const start = "- [ ] a ^aa\n- [ ] b ^bb\n- [ ] c ^cc\n";
    const top = applyListOps(parseList(start), [{ op: "move", id: "cc", to: "top" }]).doc;
    expect(ids(renderList(top))).toEqual(["cc", "aa", "bb"]);
    const after = applyListOps(parseList(start), [{ op: "move", id: "aa", to: "after:bb" }]).doc;
    expect(ids(renderList(after))).toEqual(["bb", "aa", "cc"]);
  });

  it("fails with item_not_found for a missing item, applying nothing", () => {
    const base = parseList("- [ ] a ^aa\n");
    const attempt = () =>
      applyListOps(base, [
        { op: "check", id: "aa" },
        { op: "check", id: "zz" },
      ]);
    expect(attempt).toThrow(ListOpError);
    try {
      attempt();
    } catch (error) {
      expect((error as ListOpError).code).toBe("item_not_found");
    }
    expect(renderList(base)).toBe("- [ ] a ^aa\n");
  });

  it("refuses multi-line text, empty text, text ending in an id and bad positions", () => {
    const base = parseList("- [ ] a ^aa\n");
    for (const op of [
      { op: "add", text: "two\nlines" },
      { op: "add", text: "   " },
      { op: "edit", id: "aa", text: "sneaky ^zz" },
      { op: "add", text: "x", at: "middle" },
      { op: "move", id: "aa", to: "after:aa" },
    ] as const) {
      expect(() => applyListOps(base, [op])).toThrow(/./);
    }
  });

  it("assigns ids on any write, even with no ops", () => {
    const { doc, applied } = applyListOps(parseList("- [ ] a\n"), [], sequence(3));
    expect(applied).toEqual([]);
    expect(listItems(doc)[0]!.id).toMatch(/^[a-z0-9]{2}$/);
  });
});

describe("fenced code and item details", () => {
  it("never treats checklist lines inside a fenced code block as items", () => {
    const body = "```md\n- [ ] example\n```\n~~~\n- [x] also code\n~~~\n- [ ] real\n";
    const doc = assignItemIds(parseList(body), () => 0.5);
    expect(listItems(doc).map((item) => item.text)).toEqual(["real"]);
    expect(renderList(doc)).toContain("- [ ] example\n```");
    expect(renderList(doc)).not.toContain("example ^");
  });

  it("moves and removes an item with its blank-separated detail paragraphs", () => {
    const body = "- [ ] a ^aa\n  first\n   \n\n  second\n- [ ] b ^bb\n\ntail\n";
    const doc = parseList(body);
    expect(listItems(doc)[0]!.details).toEqual(["  first", "   ", "", "  second"]);
    const moved = applyListOps(doc, [{ op: "move", id: "aa", to: "after:bb" }]);
    expect(renderList(moved.doc)).toBe(
      "- [ ] b ^bb\n- [ ] a ^aa\n  first\n   \n\n  second\n\ntail\n",
    );
    const removed = applyListOps(doc, [{ op: "remove", id: "aa" }]);
    expect(renderList(removed.doc)).toBe("- [ ] b ^bb\n\ntail\n");
  });
});
