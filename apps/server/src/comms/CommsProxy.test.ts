import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CommsProxy from "./CommsProxy.ts";

const TOKEN = "sentinel-admin-token-7f3a";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const settings: CommsProxy.CommsSettings = {
  convexUrl: "https://comms.test",
  tokenFile: "/unused",
  postAs: "lee",
  testMode: true,
  homeMachine: "test-box",
};

const testGroup = {
  id: "g1",
  kind: "group",
  title: "tg-one",
  members: [{ name: "lee" }, { name: "ta-ash" }],
};

const ownRegistry = {
  agents: [
    { participant: { name: "ta-ash" }, owner: { name: "lee" }, home: { machine: "test-box" } },
    { participant: { name: "ta-far" }, owner: { name: "lee" }, home: { machine: "m5" } },
  ],
};

interface Fixture {
  readonly settings?: CommsProxy.CommsSettings | undefined;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly token?: string;
  readonly query?: (name: string, args: Record<string, unknown>) => unknown;
  readonly mutation?: (name: string, args: Record<string, unknown>) => unknown;
  /** A subscription to this function throws while starting. */
  readonly failSubscribe?: string;
}

const fixture = (options: Fixture = {}) => {
  const calls: Array<{ kind: string; name: string; args: Record<string, unknown> }> = [];
  const subscriptions: Array<{
    name: string;
    push: (value: unknown) => void;
    stopped: boolean;
  }> = [];
  const backend: CommsProxy.CommsBackendShape = {
    settings: "settings" in options ? options.settings : settings,
    readToken: Effect.succeed(options.token ?? TOKEN),
    query: async (name, args) => {
      calls.push({ kind: "query", name, args });
      return options.query ? options.query(name, args) : {};
    },
    mutation: async (name, args) => {
      calls.push({ kind: "mutation", name, args });
      return options.mutation ? options.mutation(name, args) : {};
    },
    subscribe: (name, args, onValue) => {
      if (name === options.failSubscribe) throw new Error("subscribe failed");
      calls.push({ kind: "subscribe", name, args });
      const subscription = { name, push: onValue, stopped: false };
      subscriptions.push(subscription);
      queueMicrotask(() => onValue(options.query ? options.query(name, args) : {}));
      return () => {
        subscription.stopped = true;
      };
    },
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    CommsProxy.routeLayer.pipe(
      Layer.provideMerge(Layer.succeed(CommsProxy.CommsBackend, backend)),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "browser-session-cookie",
              scopes: options.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const call = (name: string, args: Record<string, unknown>, kind?: string) =>
    handler(
      new Request("http://t3.test/api/comms/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, args, ...(kind ? { kind } : {}) }),
      }),
    );
  return { handler, call, calls, subscriptions };
};

describe("comms proxy", () => {
  it("answers 404 and calls nothing when comms isn't configured", async () => {
    const { handler, call, calls } = fixture({ settings: undefined });
    expect((await handler(new Request("http://t3.test/api/comms/config"))).status).toBe(404);
    expect((await call("directory:list", {})).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("reports the configuration without the token", async () => {
    const { handler } = fixture();
    const response = await handler(new Request("http://t3.test/api/comms/config"));
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      enabled: true,
      testMode: true,
      postAs: "lee",
      homeMachine: "test-box",
    });
    expect(body).not.toContain(TOKEN);
  });

  it("needs operate scope for mutations and never reaches comms without it", async () => {
    const reader = fixture({ scopes: [AuthOrchestrationReadScope] });
    const denied = await reader.call("directory:setState", { name: "ta-ash", state: "paused" });
    expect(denied.status).toBe(403);
    expect(reader.calls).toEqual([]);
    expect((await reader.call("directory:list", {})).status).toBe(200);
  });

  it("refuses functions outside the allowlist", async () => {
    const { call, calls } = fixture();
    expect((await call("connector:work", {})).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("adds the admin token server-side", async () => {
    const { call, calls } = fixture();
    expect((await call("directory:list", {})).status).toBe(200);
    expect(calls).toEqual([{ kind: "query", name: "directory:list", args: { adminToken: TOKEN } }]);
  });

  it("answers 503 when the token file is empty", async () => {
    const { call, calls } = fixture({ token: "" });
    expect((await call("directory:list", {})).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("never returns an upstream error that echoes the token", async () => {
    const { call } = fixture({
      query: () => {
        throw new Error(`ArgumentValidationError: {"adminToken":"${TOKEN}"}`);
      },
    });
    const response = await call("directory:list", {});
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain("details withheld");
  });

  it("passes the server's own refusals, scrubbed of the token", async () => {
    const { call } = fixture({
      mutation: () => {
        throw Object.assign(new Error("ConvexError"), {
          data: { code: "conflict", message: `@ta-ash already exists ${TOKEN}` },
        });
      },
      query: (name) =>
        name === "registry:list"
          ? { agents: [] }
          : { conversation: testGroup, members: [], messages: [] },
    });
    const response = await call("directory:promote", {
      name: "ta-ash",
      kind: "agent",
      owner: "lee",
      home: { machine: "test-box", harness: "t3", locator: "t" },
    });
    const body = (await response.json()) as { error: { message: string; data: { code: string } } };
    expect(response.status).toBe(400);
    expect(body.error.data.code).toBe("conflict");
    expect(body.error.message).toBe("@ta-ash already exists [redacted]");
  });

  it("test mode: changes only test agents this instance owns and homes", async () => {
    const registry = {
      agents: [
        { participant: { name: "ta-mine" }, owner: { name: "lee" }, home: { machine: "test-box" } },
        { participant: { name: "ta-other" }, owner: { name: "lee" }, home: { machine: "m5" } },
      ],
    };
    const { call, calls } = fixture({ query: () => registry });
    expect((await call("directory:setState", { name: "ta-mine", state: "paused" })).status).toBe(
      200,
    );
    const refused = await call("directory:setState", { name: "ta-other", state: "retired" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
      /isn't homed on test-box/,
    );
    expect(calls.filter((c) => c.kind === "mutation").map((c) => c.args.name)).toEqual(["ta-mine"]);
  });

  const openWatch = async (handler: (request: Request) => Promise<Response>, queries: unknown) => {
    const response = await handler(
      new Request("http://t3.test/api/comms/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries }),
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const next = async (): Promise<{
      id: string;
      value?: unknown;
      error?: { message: string };
    }> => {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = JSON.parse(line) as { id?: string };
          if (parsed.id) return parsed as Awaited<ReturnType<typeof next>>;
          continue;
        }
        const { value } = await reader.read();
        buffer += value ?? "";
      }
    };
    return { next, reader };
  };

  it.each([
    ["a non-test member is added", { name: "kit" }],
    ["another machine's test agent is added", { name: "ta-far" }],
  ])("test mode: stops a watched view once %s", async (_label, added) => {
    let conversation = testGroup;
    const { handler, subscriptions } = fixture({
      query: (name) =>
        name === "registry:list" ? ownRegistry : { conversation, members: [], messages: [] },
    });
    const { next, reader } = await openWatch(handler, [
      { id: "v", name: "conversations:view", args: { conversationId: "g1" } },
    ]);
    expect((await next()).value).toBeDefined();
    conversation = { ...testGroup, members: [...testGroup.members, added] };
    const view = subscriptions.find((s) => s.name === "conversations:view")!;
    view.push({ conversation, members: [], messages: [] });
    expect((await next()).error?.message).toMatch(/isn't a test conversation/);
    expect(view.stopped).toBe(true);
    await reader.cancel();
  });

  it("test mode: stops a watched view when a member is rebound to another machine", async () => {
    const { handler, subscriptions } = fixture({
      query: (name) =>
        name === "registry:list"
          ? ownRegistry
          : { conversation: testGroup, members: [], messages: [] },
    });
    const { next, reader } = await openWatch(handler, [
      { id: "v", name: "conversations:view", args: { conversationId: "g1" } },
    ]);
    expect((await next()).value).toBeDefined();
    const registry = subscriptions.find((s) => s.name === "registry:list")!;
    registry.push({
      agents: [
        { participant: { name: "ta-ash" }, owner: { name: "lee" }, home: { machine: "m5" } },
      ],
    });
    expect((await next()).error?.message).toMatch(/isn't a test conversation/);
    expect(subscriptions.find((s) => s.name === "conversations:view")!.stopped).toBe(true);
    await reader.cancel();
  });

  it("releases every subscription when the client goes away", async () => {
    const { handler, subscriptions } = fixture({
      query: (name) => (name === "registry:list" ? ownRegistry : { conversations: [testGroup] }),
    });
    const response = await handler(
      new Request("http://t3.test/api/comms/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: [
            { id: "a", name: "conversations:list", args: {} },
            { id: "b", name: "directory:list", args: {} },
          ],
        }),
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() =>
      expect(subscriptions.map((s) => s.stopped)).toEqual(subscriptions.map(() => true)),
    );
    expect(subscriptions.length).toBeGreaterThanOrEqual(2);
  });
  it("test mode: a group can't include, or a post wake, another instance's test agent", async () => {
    const registry = {
      agents: [
        { participant: { name: "ta-ash" }, owner: { name: "lee" }, home: { machine: "test-box" } },
        { participant: { name: "ta-far" }, owner: { name: "lee" }, home: { machine: "m5" } },
      ],
    };
    const { call, calls } = fixture({
      query: (name) =>
        name === "registry:list"
          ? registry
          : { conversation: testGroup, members: [], messages: [] },
    });
    expect(
      (await call("conversations:createGroup", { title: "tg-x", members: ["lee", "ta-far"] }))
        .status,
    ).toBe(403);
    expect(
      (await call("conversations:addMember", { conversationId: "g1", name: "ta-far" })).status,
    ).toBe(403);
    const post = { as: "lee", conversationId: "g1", text: "hi" };
    expect((await call("conversations:postAs", { ...post, to: ["ta-far"] })).status).toBe(403);
    expect((await call("conversations:postAs", { ...post, to: ["ta-ash"] })).status).toBe(200);
    expect(calls.filter((c) => c.kind === "mutation").map((c) => c.name)).toEqual([
      "conversations:postAs",
    ]);
  });

  it("test mode: archives a group only when every named conversation is a test group", async () => {
    const realGroup = { id: "g2", kind: "group", title: "team", members: [{ name: "lee" }] };
    const { call, calls } = fixture({
      query: (name, args) =>
        name === "registry:list"
          ? ownRegistry
          : {
              conversation: args.conversationId === "g2" ? realGroup : testGroup,
              members: [],
              messages: [],
            },
    });
    const archive = (conversationIds: string[]) =>
      call("conversations:archiveConversation", { as: "lee", conversationIds });
    expect((await archive(["g1", "g2"])).status).toBe(403);
    expect((await archive(["g2"])).status).toBe(403);
    expect((await archive(["g1"])).status).toBe(200);
    expect(
      (await call("conversations:unarchiveConversation", { as: "lee", conversationIds: ["g1"] }))
        .status,
    ).toBe(200);
    expect(calls.filter((c) => c.kind === "mutation").map((c) => c.name)).toEqual([
      "conversations:archiveConversation",
      "conversations:unarchiveConversation",
    ]);
  });

  it("refuses a watch that names the same query id twice", async () => {
    const { handler, calls } = fixture();
    const response = await handler(
      new Request("http://t3.test/api/comms/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: [
            { id: "a", name: "directory:list", args: {} },
            { id: "a", name: "registry:list", args: {} },
          ],
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("releases the subscriptions already started when a later one fails to start", async () => {
    const { handler, subscriptions } = fixture({
      settings: { ...settings, testMode: false },
      failSubscribe: "registry:list",
    });
    const response = await handler(
      new Request("http://t3.test/api/comms/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: [
            { id: "a", name: "directory:list", args: {} },
            { id: "b", name: "registry:list", args: {} },
          ],
        }),
      }),
    );
    // Start reading so the stream sets up; the failed start ends it.
    const reader = response.body!.getReader();
    void reader.read().catch(() => undefined);
    await vi.waitFor(() => expect(subscriptions.map((s) => s.stopped)).toEqual([true]));
    await reader.cancel().catch(() => undefined);
  });
  it("keeps its registry subscription apart from client query ids", async () => {
    const { handler, subscriptions } = fixture({
      query: (name) => (name === "registry:list" ? ownRegistry : { conversations: [testGroup] }),
    });
    const { next, reader } = await openWatch(handler, [
      { id: "\u0000registry", name: "conversations:list", args: {} },
    ]);
    expect((await next()).id).toBe("\u0000registry");
    await reader.cancel();
    await vi.waitFor(() =>
      expect(subscriptions.map((s) => s.stopped)).toEqual(subscriptions.map(() => true)),
    );
    expect(subscriptions.map((s) => s.name).toSorted()).toEqual([
      "conversations:list",
      "registry:list",
    ]);
  });

  it("doesn't resend views when a registry update leaves its own agents unchanged", async () => {
    const { handler, subscriptions } = fixture({
      query: (name) =>
        name === "registry:list"
          ? ownRegistry
          : { conversation: testGroup, members: [], messages: [] },
    });
    const { next, reader } = await openWatch(handler, [
      { id: "v", name: "conversations:view", args: { conversationId: "g1" } },
    ]);
    expect((await next()).id).toBe("v");
    const registry = subscriptions.find((s) => s.name === "registry:list")!;
    registry.push(ownRegistry);
    // A real change comes next; it must be the very next frame.
    registry.push({ agents: [] });
    expect((await next()).error?.message).toMatch(/isn't a test conversation/);
    await reader.cancel();
  });
  it("coalesces a slow client's frames to the latest value per query", async () => {
    const { handler, subscriptions } = fixture({
      settings: { ...settings, testMode: false },
      query: () => ({ n: 0 }),
    });
    const { next, reader } = await openWatch(handler, [
      { id: "d", name: "directory:list", args: {} },
    ]);
    expect((await next()).value).toEqual({ n: 0 });
    // A burst the client hasn't read: only the newest survives.
    const directory = subscriptions.find((s) => s.name === "directory:list")!;
    for (let n = 1; n <= 1000; n++) directory.push({ n });
    const seen: unknown[] = [];
    while (seen.length < 4) {
      const frame = await next();
      seen.push(frame.value);
      if ((frame.value as { n: number }).n === 1000) break;
    }
    expect(seen.at(-1)).toEqual({ n: 1000 });
    expect(seen.length).toBeLessThanOrEqual(3);
    await reader.cancel();
  });
});
