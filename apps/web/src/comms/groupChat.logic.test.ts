import { describe, expect, it } from "vite-plus/test";

import type { ConversationMessage, ParticipantRef } from "./commsTypes";
import {
  applyMention,
  archiveBatches,
  draftRecipients,
  filterGroupChats,
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

describe("archiving", () => {
  const chat = (id: string, title: string | undefined, names: string[]) =>
    ({
      id,
      kind: "group",
      title,
      members: names.map((name) => ref(name)),
      lastSeq: 0,
      readSeq: 0,
      unread: 0,
    }) as const;

  it("splits ids into server-sized batches without duplicates", () => {
    expect(archiveBatches(["a", "b", "a", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(archiveBatches([])).toEqual([]);
    expect(
      archiveBatches(Array.from({ length: 205 }, (_, i) => `c${i}`)).map((b) => b.length),
    ).toEqual([100, 100, 5]);
  });

  it("filters group chats by title or member name", () => {
    const chats = [
      chat("1", "tg-smoke", ["lee"]),
      chat("2", "ops", ["kit"]),
      chat("3", undefined, ["ta-ash"]),
    ];
    expect(filterGroupChats(chats, " TG- ").map((c) => c.id)).toEqual(["1"]);
    expect(filterGroupChats(chats, "kit").map((c) => c.id)).toEqual(["2"]);
    expect(filterGroupChats(chats, "ta-").map((c) => c.id)).toEqual(["3"]);
    expect(filterGroupChats(chats, "")).toHaveLength(3);
  });
});
