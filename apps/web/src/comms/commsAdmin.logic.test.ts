import { describe, expect, it } from "vite-plus/test";

import {
  filterRoster,
  isOwnTestParticipant,
  harnessLocator,
  harnessOptions,
  machineOptions,
  localThreadId,
  nameProblem,
  parseDuties,
  PRESENCE_STALE_MS,
  presenceView,
  sortRoster,
} from "./commsAdmin.logic";
import type { RegistryEntry } from "./commsTypes";

const now = 1_000_000_000;
const agent = (name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  participant: { id: name, name, kind: "agent" },
  state: "active",
  presence: { status: "idle", at: now - 1000, idleSince: now - 120_000 },
  harness: "t3",
  home: { machine: "m", harness: "t3", locator: `thread-${name}` },
  ...over,
});
const seen = new Map([["m", now - 1000]]);

describe("presenceView", () => {
  it("reads idle, busy and offline from a live machine", () => {
    expect(presenceView(agent("a"), seen, now)).toEqual({ status: "idle", label: "idle 2m" });
    expect(
      presenceView(agent("a", { presence: { status: "busy", at: now } }), seen, now).status,
    ).toBe("busy");
  });

  it("never trusts a stale machine", () => {
    const old = new Map([["m", now - PRESENCE_STALE_MS - 1]]);
    expect(presenceView(agent("a"), old, now).status).toBe("stale");
    expect(presenceView(agent("a"), new Map(), now).label).toBe("connector never heard from");
  });

  it("shows state before presence, and people as people", () => {
    expect(presenceView(agent("a", { state: "paused" }), seen, now).status).toBe("paused");
    const person: RegistryEntry = {
      participant: { id: "lee", name: "lee", kind: "human" },
      state: "active",
      presence: null,
    };
    expect(presenceView(person, seen, now).status).toBe("person");
    expect(presenceView(agent("a", { presence: null }), seen, now).status).toBe("offline");
  });
});

describe("roster", () => {
  it("sorts agents before people, retired last", () => {
    const person: RegistryEntry = {
      participant: { id: "lee", name: "lee", kind: "human" },
      state: "active",
      presence: null,
    };
    const order = sortRoster([agent("b", { state: "retired" }), person, agent("c"), agent("a")]);
    expect(order.map((e) => e.participant.name)).toEqual(["a", "c", "lee", "b"]);
  });

  it("filters by name or description and hides retired", () => {
    const entries = [
      agent("kit", { description: "comms steward" }),
      agent("old", { state: "retired" }),
    ];
    expect(filterRoster(entries, { query: "steward", showRetired: false })).toHaveLength(1);
    expect(filterRoster(entries, { query: "@ol", showRetired: false })).toHaveLength(0);
    expect(filterRoster(entries, { query: "@ol", showRetired: true })).toHaveLength(1);
  });

  it("links an agent's thread only when it's homed on this server's machine", () => {
    expect(localThreadId(agent("a"), "m")).toBe("thread-a");
    expect(localThreadId(agent("a"), "other")).toBeNull();
    expect(localThreadId(agent("a"), null)).toBeNull();
  });
});

describe("forms", () => {
  it("checks names", () => {
    expect(nameProblem("ta-elm", new Set())).toBeUndefined();
    expect(nameProblem("Ta-Elm", new Set())).toMatch(/lowercase/);
    expect(nameProblem("ta-elm", new Set(["ta-elm"]))).toMatch(/already exists/);
  });

  it("parses duties one per line", () => {
    expect(parseDuties(" a \n\n b\n")).toEqual(["a", "b"]);
  });
});

describe("register on another machine", () => {
  it("offers known harnesses plus any in use, never web", () => {
    const options = harnessOptions([
      agent("a", { home: { machine: "m", harness: "newh", locator: "x" } }),
    ]);
    expect(options).toContain("t3");
    expect(options).toContain("newh");
    expect(options).not.toContain("web");
  });

  it("uses the name as a Claude Code locator", () => {
    expect(harnessLocator("claude-code", "ta-x", "ignored")).toBe("ta-x");
    expect(harnessLocator("t3", "ta-x", " thr ")).toBe("thr");
  });

  it("lists machines most recently heard first", () => {
    const list = machineOptions(
      {
        participants: [],
        machines: [
          { machineId: "old", lastSeenAt: now - 600_000 },
          { machineId: "new", lastSeenAt: now - 5_000 },
          { machineId: "never", lastSeenAt: null },
        ],
      },
      now,
    );
    expect(list.map((m) => m.id)).toEqual(["new", "old", "never"]);
    expect(list[0]!.label).toBe("heard 5s ago");
  });
});

describe("test-mode ownership", () => {
  const config = { enabled: true, testMode: true, postAs: "lee", homeMachine: "m" };
  it("offers only own test agents and the post-as person", () => {
    const lee: RegistryEntry = {
      participant: { id: "lee", name: "lee", kind: "human" },
      state: "active",
      presence: null,
    };
    const own = agent("ta-own", { owner: { id: "lee", name: "lee", kind: "human" } });
    const elsewhere = agent("ta-far", {
      owner: { id: "lee", name: "lee", kind: "human" },
      home: { machine: "m5", harness: "t3", locator: "x" },
    });
    const real = agent("kit", { owner: { id: "lee", name: "lee", kind: "human" } });
    expect(isOwnTestParticipant(lee, config)).toBe(true);
    expect(isOwnTestParticipant(own, config)).toBe(true);
    expect(isOwnTestParticipant(elsewhere, config)).toBe(false);
    expect(isOwnTestParticipant(real, config)).toBe(false);
  });
});
