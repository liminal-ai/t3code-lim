// Fork-only (artifacts): list items in a markdown artifact and the ops that
// edit them. Each top-level `- [ ]` / `- [x]` line is an item, and the indented
// lines under it belong to it. An item's id is a trailing `^b7` (2-4 base36
// characters, unique in the file). Everything else in the file is kept as is.
import type { LimArtifactListOp } from "@t3tools/contracts";

const ITEM_LINE = /^([-*+]) \[([ xX])\](?: (.*))?$/;
const ITEM_ID = /^(.*?)\s*\^([a-z0-9]{2,4})$/;
const ID_TEXT = /^[a-z0-9]{2,4}$/;
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

export interface ListItem {
  readonly kind: "item";
  readonly marker: string;
  readonly checked: boolean;
  readonly text: string;
  readonly id: string | null;
  /** Indented lines under the item. */
  readonly details: ReadonlyArray<string>;
}

interface TextBlock {
  readonly kind: "text";
  readonly line: string;
}

type Block = ListItem | TextBlock;

export interface ListDocument {
  readonly blocks: ReadonlyArray<Block>;
  readonly newline: "\n" | "\r\n";
  readonly trailingNewline: boolean;
}

export class ListOpError extends Error {
  readonly code: "item_not_found" | "invalid_op";

  constructor(code: "item_not_found" | "invalid_op", message: string) {
    super(message);
    this.code = code;
  }
}

export const parseList = (body: string): ListDocument => {
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = body.endsWith("\n");
  const lines = body.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  const blocks: Block[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = ITEM_LINE.exec(line);
    if (!match) {
      blocks.push({ kind: "text", line });
      continue;
    }
    const details: string[] = [];
    while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]!)) {
      details.push(lines[++index]!);
    }
    const rest = match[3] ?? "";
    const idMatch = ITEM_ID.exec(rest);
    blocks.push({
      kind: "item",
      marker: match[1]!,
      checked: match[2] !== " ",
      text: idMatch ? idMatch[1]! : rest,
      id: idMatch ? idMatch[2]! : null,
      details,
    });
  }
  return { blocks, newline, trailingNewline };
};

const renderItem = (item: ListItem): string[] => {
  const text = item.text.length > 0 ? ` ${item.text}` : "";
  const id = item.id ? ` ^${item.id}` : "";
  return [`${item.marker} [${item.checked ? "x" : " "}]${text}${id}`, ...item.details];
};

export const renderList = (doc: ListDocument): string => {
  const lines = doc.blocks.flatMap((block) =>
    block.kind === "text" ? [block.line] : renderItem(block),
  );
  if (lines.length === 0) return "";
  return lines.join(doc.newline) + (doc.trailingNewline ? doc.newline : "");
};

export const listItems = (doc: ListDocument): ReadonlyArray<ListItem> =>
  doc.blocks.filter((block): block is ListItem => block.kind === "item");

export const inlineTags = (text: string): string[] => {
  const tags = new Set<string>();
  for (const match of text.matchAll(INLINE_TAG)) tags.add(match[1]!);
  return [...tags];
};

/** A fresh id unique among `used`: two characters while they last, then longer. */
export const newItemId = (used: ReadonlySet<string>, random: () => number = Math.random) => {
  for (let length = 2; length <= 4; length++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      let id = "";
      for (let i = 0; i < length; i++) id += Math.floor(random() * 36).toString(36);
      if (!used.has(id)) return id;
    }
  }
  throw new ListOpError("invalid_op", "this list has run out of item ids");
};

/** Every item gets an id, and duplicates (a copied line) get a new one. Returns a new doc. */
export const assignItemIds = (doc: ListDocument, random?: () => number): ListDocument => {
  const used = new Set<string>();
  for (const item of listItems(doc)) if (item.id) used.add(item.id);
  const seen = new Set<string>();
  const blocks = doc.blocks.map((block) => {
    if (block.kind !== "item") return block;
    if (block.id && !seen.has(block.id)) {
      seen.add(block.id);
      return block;
    }
    const id = newItemId(used, random);
    used.add(id);
    seen.add(id);
    return { ...block, id };
  });
  return { ...doc, blocks };
};

const checkText = (text: string) => {
  if (/[\r\n]/.test(text)) throw new ListOpError("invalid_op", "item text must be one line");
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ListOpError("invalid_op", "item text is empty");
  if (ITEM_ID.test(trimmed)) {
    throw new ListOpError("invalid_op", "item text can't end with a `^id` block reference");
  }
  return trimmed;
};

const findItem = (blocks: ReadonlyArray<Block>, id: string) => {
  const index = blocks.findIndex((block) => block.kind === "item" && block.id === id);
  if (index < 0) throw new ListOpError("item_not_found", `no item ^${id} in this list`);
  return index;
};

/** Where `at` puts an item, as an index into `blocks`. */
const insertionIndex = (blocks: ReadonlyArray<Block>, at: string | undefined) => {
  const position = at ?? "bottom";
  const itemIndexes = blocks.flatMap((block, index) => (block.kind === "item" ? [index] : []));
  if (position === "top") return itemIndexes[0] ?? blocks.length;
  if (position === "bottom") {
    const last = itemIndexes.at(-1);
    return last === undefined ? blocks.length : last + 1;
  }
  if (position.startsWith("after:")) {
    const id = position.slice("after:".length);
    if (!ID_TEXT.test(id)) throw new ListOpError("invalid_op", `bad position ${position}`);
    return findItem(blocks, id) + 1;
  }
  throw new ListOpError(
    "invalid_op",
    `position must be top, bottom or after:<id>, not ${position}`,
  );
};

/** A new item block, separated from prose above it by a blank line. */
const insertItem = (blocks: Block[], index: number, item: ListItem) => {
  const before = blocks[index - 1];
  if (before && before.kind === "text" && before.line.trim().length > 0) {
    blocks.splice(index, 0, { kind: "text", line: "" }, item);
    return;
  }
  blocks.splice(index, 0, item);
};

export interface AppliedOp {
  readonly op: LimArtifactListOp["op"];
  readonly itemId: string;
  readonly summary: string;
}

const quote = (text: string) => {
  const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `'${short}'`;
};

/**
 * Applies ops in order to the current document, all or none (an error leaves
 * nothing applied). Ids are assigned first, as on every T3 write.
 */
export const applyListOps = (
  current: ListDocument,
  ops: ReadonlyArray<LimArtifactListOp>,
  random?: () => number,
): { readonly doc: ListDocument; readonly applied: ReadonlyArray<AppliedOp> } => {
  const doc = assignItemIds(current, random);
  const blocks = [...doc.blocks];
  const applied: AppliedOp[] = [];
  const used = () =>
    new Set(blocks.flatMap((block) => (block.kind === "item" && block.id ? [block.id] : [])));
  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const text = checkText(op.text);
        const id = newItemId(used(), random);
        const item: ListItem = { kind: "item", marker: "-", checked: false, text, id, details: [] };
        insertItem(blocks, insertionIndex(blocks, op.at), item);
        applied.push({ op: op.op, itemId: id, summary: `added ${quote(text)}` });
        break;
      }
      case "edit": {
        const text = checkText(op.text);
        const index = findItem(blocks, op.id);
        const item = blocks[index] as ListItem;
        blocks[index] = { ...item, text };
        applied.push({ op: op.op, itemId: op.id, summary: `edited ${quote(text)}` });
        break;
      }
      case "check":
      case "uncheck": {
        const index = findItem(blocks, op.id);
        const item = blocks[index] as ListItem;
        blocks[index] = { ...item, checked: op.op === "check" };
        applied.push({ op: op.op, itemId: op.id, summary: `${op.op}ed ${quote(item.text)}` });
        break;
      }
      case "move": {
        const index = findItem(blocks, op.id);
        if (op.to === `after:${op.id}`) {
          throw new ListOpError("invalid_op", "an item can't move after itself");
        }
        const [item] = blocks.splice(index, 1) as [ListItem];
        blocks.splice(insertionIndex(blocks, op.to), 0, item);
        applied.push({ op: op.op, itemId: op.id, summary: `moved ${quote(item.text)}` });
        break;
      }
      case "remove": {
        const index = findItem(blocks, op.id);
        const [item] = blocks.splice(index, 1) as [ListItem];
        applied.push({ op: op.op, itemId: op.id, summary: `removed ${quote(item.text)}` });
        break;
      }
    }
  }
  return { doc: { ...doc, blocks, trailingNewline: true }, applied };
};
