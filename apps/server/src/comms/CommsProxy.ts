// Fork-only (agent comms): the browser's path to the comms server. The page
// calls /api/comms/* on this T3 server with its own session; this server adds
// the comms admin token, read server-side from a file per request, and talks to
// the comms Convex deployment. No browser ever holds the admin token.
//
// The wire shape follows agent-comms' local mode (`POST /api/call`, and
// `POST /api/watch` streaming NDJSON frames `{id, value}` / `{id, error}`), so
// the comms web view's client logic carries over.
//
// Configuration (all optional; without a URL and token file the routes answer
// 404 and the UI hides itself):
//   COMMS_CONVEX_URL         the comms deployment, e.g. https://<name>.convex.cloud
//   COMMS_ADMIN_TOKEN_FILE   file holding the admin token (mode 600)
//   COMMS_POST_AS            the person the UI posts as, e.g. `lee` (also the one
//                            person test mode allows)
//   COMMS_TEST_MODE=1        restrict to test participants (see commsPolicy.ts)
//   COMMS_HOME_MACHINE       the comms machine whose connector drives this T3
//                            (agents registered from its threads live there; in
//                            test mode, the only machine test agents may use)
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateHttpRequestScope } from "./commsAuth.ts";
import {
  COMMS_FUNCTIONS,
  CONVERSATION_SCOPED,
  filterTestConversations,
  isTestConversation,
  type PolicyConversation,
  testModeRefusal,
} from "./commsPolicy.ts";

export const COMMS_ROUTE_PREFIX = "/api/comms";
const MAX_WATCH_QUERIES = 32;
const HEARTBEAT = "20 seconds";

interface CommsSettings {
  readonly convexUrl: string;
  readonly tokenFile: string;
  readonly postAs: string | undefined;
  readonly testMode: boolean;
  readonly homeMachine: string | undefined;
}

const testOptions = (settings: CommsSettings) => ({
  testMachine: settings.homeMachine,
  human: settings.postAs,
});

export function resolveCommsSettings(
  env: NodeJS.ProcessEnv = process.env,
): CommsSettings | undefined {
  const convexUrl = env.COMMS_CONVEX_URL?.trim();
  const tokenFile = env.COMMS_ADMIN_TOKEN_FILE?.trim();
  if (!convexUrl || !tokenFile) return undefined;
  return {
    convexUrl,
    tokenFile,
    postAs: env.COMMS_POST_AS?.trim() || undefined,
    testMode: env.COMMS_TEST_MODE === "1",
    homeMachine: (env.COMMS_HOME_MACHINE ?? env.COMMS_TEST_MACHINE)?.trim() || undefined,
  };
}

let sharedClient: { readonly url: string; readonly client: ConvexClient } | undefined;

/** One Convex connection per server, shared by every call and watch. */
function convexClient(url: string): ConvexClient {
  if (sharedClient?.url !== url) {
    void sharedClient?.client.close();
    sharedClient = { url, client: new ConvexClient(url) };
  }
  return sharedClient.client;
}

/** A function's error for the page: a ConvexError's data, else its message. Never the args. */
export function describeCommsError(error: unknown): { message: string; data?: unknown } {
  const data = (error as { data?: unknown } | null)?.data;
  if (data !== undefined) {
    const message =
      typeof data === "object" &&
      data &&
      typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : JSON.stringify(data);
    return { message: message.slice(0, 1_000), data };
  }
  return { message: String((error as Error | null)?.message ?? error).slice(0, 1_000) };
}

class CommsCallError extends Data.TaggedError("CommsCallError")<{
  readonly status: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

const callError = (status: number, message: string, data?: unknown): CommsCallError =>
  new CommsCallError({ status, message, data });

const errorResponse = (status: number, message: string, data?: unknown) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, ...(data !== undefined ? { data } : {}) } },
    { status },
  );

const readJsonObject = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(
    Effect.mapError(() => callError(400, "the body must be JSON")),
  );
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return yield* callError(400, "the body must be a JSON object");
  }
  return body as Record<string, unknown>;
});

const readToken = (settings: CommsSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const token = yield* fs.readFileString(settings.tokenFile).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (!token) return yield* callError(503, "comms admin token unavailable");
    return token;
  });

const asArgs = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const runQuery = (client: ConvexClient, name: string, args: Record<string, unknown>) =>
  Effect.tryPromise({
    try: () => client.query(makeFunctionReference<"query">(name), args),
    catch: (error) => {
      const described = describeCommsError(error);
      return callError(400, described.message, described.data);
    },
  });

/** Test mode: the conversation a scoped call names must be a test conversation. */
const requireTestConversation = (
  settings: CommsSettings,
  client: ConvexClient,
  token: string,
  conversationId: unknown,
) =>
  Effect.gen(function* () {
    if (typeof conversationId !== "string") {
      return yield* callError(400, "conversationId is required");
    }
    const view = (yield* runQuery(client, "conversations:view", {
      adminToken: token,
      conversationId,
      limit: 1,
    })) as { conversation: PolicyConversation };
    if (!isTestConversation(view.conversation, testOptions(settings))) {
      return yield* callError(403, "test mode: that conversation isn't a test conversation");
    }
  });

/** Test mode trims what a query returns to test conversations. */
function shapeForTestMode(settings: CommsSettings, name: string, value: unknown): unknown {
  if (name === "conversations:list") {
    const list = value as { conversations: ReadonlyArray<PolicyConversation> };
    return {
      ...list,
      conversations: filterTestConversations(list.conversations, testOptions(settings)),
    };
  }
  return value;
}

const checkCall = (
  settings: CommsSettings,
  client: ConvexClient,
  token: string,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    if (!settings.testMode) return;
    const refusal = testModeRefusal(name, args, testOptions(settings));
    if (refusal) return yield* callError(403, refusal);
    if (CONVERSATION_SCOPED.has(name)) {
      yield* requireTestConversation(settings, client, token, args.conversationId);
    }
  });

const resolveFunction = (name: unknown, kind?: unknown) => {
  if (typeof name !== "string" || !(name in COMMS_FUNCTIONS)) {
    return Effect.fail(callError(404, `no comms function ${String(name)}`));
  }
  const actual = COMMS_FUNCTIONS[name]!;
  if (kind !== undefined && kind !== actual) {
    return Effect.fail(callError(400, `${name} is a ${actual}`));
  }
  return Effect.succeed({ name, kind: actual });
};

const configHandler = (settings: CommsSettings) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    return HttpServerResponse.jsonUnsafe({
      enabled: true,
      testMode: settings.testMode,
      postAs: settings.postAs ?? null,
      homeMachine: settings.homeMachine ?? null,
    });
  });

const callHandler = (settings: CommsSettings) =>
  Effect.gen(function* () {
    const body = yield* readJsonObject;
    const fn = yield* resolveFunction(body.name, body.kind);
    yield* authenticateHttpRequestScope(
      fn.kind === "mutation" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    );
    const token = yield* readToken(settings);
    const client = convexClient(settings.convexUrl);
    const args = asArgs(body.args);
    yield* checkCall(settings, client, token, fn.name, args);
    const withToken = { ...args, adminToken: token };
    const value = yield* fn.kind === "mutation"
      ? Effect.tryPromise({
          try: () => client.mutation(makeFunctionReference<"mutation">(fn.name), withToken),
          catch: (error) => {
            const described = describeCommsError(error);
            return callError(400, described.message, described.data);
          },
        })
      : runQuery(client, fn.name, withToken);
    return HttpServerResponse.jsonUnsafe({
      value: settings.testMode ? shapeForTestMode(settings, fn.name, value) : value,
    });
  });

interface WatchQuery {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const watchHandler = (settings: CommsSettings) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    const body = yield* readJsonObject;
    const raw = body.queries;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WATCH_QUERIES) {
      return yield* callError(400, `"queries" must list 1-${MAX_WATCH_QUERIES} queries`);
    }
    const queries: WatchQuery[] = [];
    for (const entry of raw) {
      const q = asArgs(entry);
      if (typeof q.id !== "string" || q.id.length > 512) {
        return yield* callError(400, "each query needs a string id");
      }
      const fn = yield* resolveFunction(q.name, "query");
      queries.push({ id: q.id, name: fn.name, args: asArgs(q.args) });
    }
    const token = yield* readToken(settings);
    const client = convexClient(settings.convexUrl);
    // Test mode checks each scoped query once, up front; a refused one streams its error.
    const refused = new Map<string, { message: string }>();
    for (const q of queries) {
      const check = yield* Effect.result(checkCall(settings, client, token, q.name, q.args));
      if (check._tag === "Failure") refused.set(q.id, { message: check.failure.message });
    }

    const encoder = new TextEncoder();
    const frame = (line: unknown) => encoder.encode(`${JSON.stringify(line)}\n`);
    const frames = Stream.callback<Uint8Array>((queue) =>
      Effect.gen(function* () {
        const offer = (line: unknown) => Queue.offerUnsafe(queue, frame(line));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const stops: Array<() => void> = [];
            for (const q of queries) {
              const refusal = refused.get(q.id);
              if (refusal) {
                offer({ id: q.id, error: refusal });
                continue;
              }
              const unsubscribe = client.onUpdate(
                makeFunctionReference<"query">(q.name),
                { ...q.args, adminToken: token },
                (value) =>
                  offer({
                    id: q.id,
                    value: settings.testMode ? shapeForTestMode(settings, q.name, value) : value,
                  }),
                (error) => offer({ id: q.id, error: describeCommsError(error) }),
              );
              stops.push(() => unsubscribe());
            }
            return stops;
          }),
          (stops) => Effect.sync(() => stops.forEach((stop) => stop())),
        );
        // Heartbeats keep idle streams open through proxies.
        yield* Effect.sync(() => offer({})).pipe(
          Effect.repeat(Schedule.spaced(HEARTBEAT)),
          Effect.forkScoped,
        );
      }),
    );
    return HttpServerResponse.stream(frames, {
      contentType: "application/x-ndjson; charset=utf-8",
      headers: { "cache-control": "no-store" },
    });
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const settings = resolveCommsSettings();
  if (!settings) return errorResponse(404, "comms isn't configured on this server");
  const route = url.value.pathname.slice(COMMS_ROUTE_PREFIX.length);
  const method =
    route === "/config" ? "GET" : route === "/call" || route === "/watch" ? "POST" : null;
  if (!method) return errorResponse(404, "no such comms endpoint");
  if (request.method !== method) return errorResponse(405, `${method} only`);
  const run =
    route === "/config"
      ? configHandler(settings)
      : route === "/call"
        ? callHandler(settings)
        : watchHandler(settings);
  return yield* run.pipe(
    Effect.catchTags({
      CommsCallError: (error) =>
        Effect.succeed(errorResponse(error.status, error.message, error.data)),
    }),
  );
});

export const routeLayer = HttpRouter.add("*", `${COMMS_ROUTE_PREFIX}/*`, handler);
