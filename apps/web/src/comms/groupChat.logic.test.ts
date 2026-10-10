import { describe, expect, it } from "vite-plus/test";

import { CommsError } from "./commsClient";
import type { ConversationMessage, ConversationSummary, ParticipantRef } from "./commsTypes";
import {
  applyMention,
  bulkDeleteProblem,
  deleteBatches,
  deleteInBatches,
  draftRecipients,
  filterGroupChats,
  isUnknownConversationError,
  memberActivity,
  mentionQueryAt,
  parseRecipients,
  wakeableMembers,
  wakePreviewLabel,
} from "./groupChat.logic";

const ref = (name: string, kind: ParticipantRef["kind"] = "agent"): ParticipantRef => ({
  id: name,
  name,
  kind,
});
const members = [ref("lee", "human"), ref("ta-ash"), ref("ta-birch")];
const candidates = wakeableMembers(members, "lee");

describe("recipients", () => {
  it("leaves the poster out of the wakeable members", () => {
    expect(candidates.map((m) => m.name)).toEqual(["ta-ash", "ta-birch"]);
  });

  it("unions checked members with @mentions, in member order", () => {
    expect(draftRecipients("hi @ta-birch", candidates, new Set())).toEqual(["ta-birch"]);
    expect(draftRecipients("hi", candidates, new Set(["ta-ash"]))).toEqual(["ta-ash"]);
    expect(draftRecipients("@ta-birch", candidates, new Set(["ta-ash"]))).toEqual([
      "ta-ash",
      "ta-birch",
    ]);
    expect(draftRecipients("@all go", candidates, new Set())).toEqual(["ta-ash", "ta-birch"]);
  });

  it("doesn't match a name inside a longer name or an email", () => {
    expect(draftRecipients("@ta-ashley", candidates, new Set())).toEqual([]);
    expect(draftRecipients("x@ta-ash", candidates, new Set())).toEqual([]);
  });

  it("previews who a post wakes", () => {
    expect(wakePreviewLabel([], candidates)).toMatch(/nobody/);
    expect(wakePreviewLabel(["ta-ash"], candidates)).toBe("Wakes @ta-ash");
    expect(wakePreviewLabel(["ta-ash", "ta-birch"], candidates)).toBe("Wakes everyone");
  });

  it("drops stored names no longer in the chat", () => {
    expect([...parseRecipients('["ta-ash","kit"]', candidates)]).toEqual(["ta-ash"]);
    expect(parseRecipients("not json", candidates).size).toBe(0);
  });
});

describe("mentions", () => {
  it("finds the mention at the caret and completes it", () => {
    const text = "hey @ta-b";
    const mention = mentionQueryAt(text, text.length);
    expect(mention).toEqual({ start: 4, query: "ta-b" });
    expect(applyMention(text, mention!, "ta-birch")).toEqual({
      text: "hey @ta-birch ",
      caret: 14,
    });
  });
});

describe("memberActivity", () => {
  const message = (
    states: Record<string, string>,
    kind: ConversationMessage["message"]["kind"] = "request",
  ): ConversationMessage =>
    ({
      message: { kind } as ConversationMessage["message"],
      deliveries: Object.entries(states).map(([recipient, state]) => ({
        id: recipient,
        recipient,
        state,
        at: 0,
      })),
    }) as ConversationMessage;

  it("reads each member's latest delivery", () => {
    const activity = memberActivity([
      message({ "ta-ash": "failed", "ta-birch": "replied" }),
      message({ "ta-ash": "delivered" }),
    ]);
    expect(activity.get("ta-ash")).toBe("working");
    expect(activity.get("ta-birch")).toBe("idle");
    expect(memberActivity([message({ "ta-ash": "uncertain" })]).get("ta-ash")).toBe("failed");
    // An older request still in flight keeps the agent working after a newer one is answered.
    expect(
      memberActivity([message({ "ta-ash": "delivered" }), message({ "ta-ash": "replied" })]).get(
        "ta-ash",
      ),
    ).toBe("working");
    // A delivered answer is finished, not work.
    expect(
      memberActivity([
        message({ "ta-ash": "delivered" }, "answer"),
        message({ "ta-ash": "replied" }),
      ]).get("ta-ash"),
    ).toBe("idle");
  });
});

// Group delete (Lee, 2026-10-09; Mira #258/#262).
describe("group delete helpers", () => {
  it("splits ids into calls of at most 100, dropping duplicates", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `g${index}`);
    const batches = deleteBatches([...ids, "g0", "g1"]);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
    expect(deleteBatches([])).toEqual([]);
  });

  it("filters chats by title or member, case-insensitively", () => {
    const chat = (id: string, title: string, members: string[]): ConversationSummary => ({
      id,
      kind: "group",
      title,
      members: members.map((name) => ({ id: name, name, kind: "agent" }) as ParticipantRef),
      lastSeq: 0,
      readSeq: 0,
      unread: 0,
    });
    const chats = [chat("a", "tg-smoke", ["ta-ash"]), chat("b", "Release", ["kit"])];
    expect(filterGroupChats(chats, "  TG-").map((c) => c.id)).toEqual(["a"]);
    expect(filterGroupChats(chats, "kit").map((c) => c.id)).toEqual(["b"]);
    expect(filterGroupChats(chats, "").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("recognizes a deleted conversation by its code", () => {
    const gone = new CommsError("no such conversation", 400, { code: "unknown_conversation" });
    expect(isUnknownConversationError(gone)).toBe(true);
    expect(isUnknownConversationError(new Error("unknown_conversation: g1"))).toBe(true);
    expect(isUnknownConversationError(new CommsError("forbidden", 403))).toBe(false);
    expect(isUnknownConversationError(undefined)).toBe(false);
  });
});

// Mira #266: the two stop paths of a bulk delete, with the comms call mocked.
describe("deleteInBatches", () => {
  const ids = Array.from({ length: 250 }, (_, index) => `g${index}`);

  it("stops at a failed batch and says how many were deleted", async () => {
    const sent: number[] = [];
    const result = await deleteInBatches({
      ids,
      deleteBatch: async (batch) => {
        sent.push(batch.length);
        if (sent.length === 2) throw new Error("unknown_conversation");
      },
      routeGeneration: () => 0,
    });

    expect(sent).toEqual([100, 100]);
    expect(result.deleted).toBe(100);
    expect(bulkDeleteProblem(result.deleted, ids.length, result.error)).toBe(
      "Deleted 100 of 250; the rest weren't deleted: unknown_conversation",
    );
  });

  it("sends no further batch once comms moves to another T3", async () => {
    let generation = 0;
    const sent: number[] = [];
    const result = await deleteInBatches({
      ids,
      deleteBatch: async (batch) => {
        sent.push(batch.length);
        generation += 1;
      },
      routeGeneration: () => generation,
    });

    expect(sent).toEqual([100]);
    expect(result.deleted).toBe(100);
    expect(bulkDeleteProblem(result.deleted, ids.length, result.error)).toBe(
      "Deleted 100 of 250; the rest weren't deleted: comms moved to another T3; the rest weren't sent",
    );
  });

  it("reports nothing when every batch goes, and the bare reason when none did", async () => {
    const all = await deleteInBatches({
      ids,
      deleteBatch: async () => {},
      routeGeneration: () => 0,
    });
    expect(all).toEqual({ deleted: 250, error: null });
    expect(bulkDeleteProblem(all.deleted, ids.length, all.error)).toBeNull();
    expect(bulkDeleteProblem(0, 250, new Error("bad_request"))).toBe("bad_request");
  });
});
