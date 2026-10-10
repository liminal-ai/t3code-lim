import { describe, expect, it } from "vite-plus/test";

import { filterTestConversations, isTestConversation, testModeRefusal } from "./commsPolicy.ts";

const options = { testMachine: "lim-builder-jess", human: "lee" };
const home = (machine: string) => ({ machine, harness: "t3", locator: "thread" });
const ref = (name: string) => ({ name });

describe("testModeRefusal", () => {
  it("registers only ta- agents owned by the post-as person on the test machine", () => {
    const agent = { kind: "agent", name: "ta-ash", owner: "lee", home: home("lim-builder-jess") };
    expect(testModeRefusal("directory:promote", agent, options)).toBeUndefined();
    expect(testModeRefusal("directory:promote", { ...agent, name: "ash" }, options)).toMatch(/ta-/);
    expect(testModeRefusal("directory:promote", { ...agent, owner: "kit" }, options)).toMatch(
      /owner/,
    );
    expect(
      testModeRefusal("directory:promote", { ...agent, home: home("lim-builder") }, options),
    ).toMatch(/homed on lim-builder-jess/);
    expect(testModeRefusal("directory:promote", { kind: "human", name: "ta-x" }, options)).toMatch(
      /only test agents/,
    );
  });

  it("changes state only for test agents", () => {
    expect(testModeRefusal("directory:setState", { name: "ta-ash" }, options)).toBeUndefined();
    expect(testModeRefusal("directory:setState", { name: "kit" }, options)).toBeDefined();
    expect(testModeRefusal("directory:setState", { name: "lee" }, options)).toBeDefined();
  });

  it("creates only tg- groups of test participants", () => {
    expect(
      testModeRefusal(
        "conversations:createGroup",
        { title: "tg-x", members: ["lee", "ta-ash"] },
        options,
      ),
    ).toBeUndefined();
    expect(
      testModeRefusal("conversations:createGroup", { title: "x", members: ["lee"] }, options),
    ).toMatch(/tg-/);
    expect(
      testModeRefusal(
        "conversations:createGroup",
        { title: "tg-x", members: ["lee", "kit"] },
        options,
      ),
    ).toMatch(/every member/);
  });

  it("posts only as the post-as person to test participants", () => {
    const post = { as: "lee", conversationId: "c", to: ["ta-ash"], text: "hi" };
    expect(testModeRefusal("conversations:postAs", post, options)).toBeUndefined();
    expect(testModeRefusal("conversations:postAs", { ...post, as: "kit" }, options)).toMatch(
      /post as @lee/,
    );
    expect(testModeRefusal("conversations:postAs", { ...post, to: ["kit"] }, options)).toMatch(
      /recipient/,
    );
  });

  it("deletes groups only as the post-as person, naming at least one", () => {
    const name = "conversations:deleteConversation";
    const remove = { as: "lee", conversationIds: ["g1"] };
    expect(testModeRefusal(name, remove, options)).toBeUndefined();
    expect(testModeRefusal(name, { ...remove, as: "kit" }, options)).toMatch(/delete as @lee/);
    expect(testModeRefusal(name, { ...remove, conversationIds: [] }, options)).toMatch(
      /at least one/,
    );
    expect(testModeRefusal(name, { as: "lee", conversationId: "g1" }, options)).toMatch(
      /at least one/,
    );
  });

  it("marks read only one conversation of the post-as person's inbox", () => {
    expect(
      testModeRefusal("inbox:markRead", { human: "lee", conversationId: "c" }, options),
    ).toBeUndefined();
    expect(testModeRefusal("inbox:markRead", { human: "lee", all: true }, options)).toBeDefined();
    expect(
      testModeRefusal("inbox:markRead", { human: "kit", conversationId: "c" }, options),
    ).toBeDefined();
  });

  it("refuses reminders and alerts outright", () => {
    expect(testModeRefusal("reminders:create", {}, options)).toMatch(/unavailable/);
    expect(testModeRefusal("alerts:setConfig", {}, options)).toMatch(/unavailable/);
  });
});

describe("test conversations", () => {
  const group = (title: string, members: string[]) => ({
    kind: "group",
    title,
    members: members.map(ref),
  });

  it("is a tg- group of ta- agents and the post-as person", () => {
    expect(isTestConversation(group("tg-a", ["lee", "ta-ash"]), options)).toBe(true);
    expect(isTestConversation(group("a", ["lee", "ta-ash"]), options)).toBe(false);
    expect(isTestConversation(group("tg-a", ["lee", "kit"]), options)).toBe(false);
    expect(isTestConversation({ kind: "dm", members: [ref("lee"), ref("ta-ash")] }, options)).toBe(
      true,
    );
  });

  it("filters a conversation list to test conversations", () => {
    const list = [group("tg-a", ["lee", "ta-ash"]), group("ops", ["lee", "kit"])];
    expect(filterTestConversations(list, options).map((c) => c.title)).toEqual(["tg-a"]);
  });
});
