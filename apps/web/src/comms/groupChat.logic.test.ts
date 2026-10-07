import { describe, expect, it } from "vite-plus/test";

import type { ConversationMessage, ParticipantRef } from "./commsTypes";
import {
  applyMention,
  draftRecipients,
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
  const message = (states: Record<string, string>): ConversationMessage =>
    ({
      message: {} as ConversationMessage["message"],
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
  });
});
