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
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateHttpRequestScope } from "./commsAuth.ts";
import {
  COMMS_FUNCTIONS,
  CONVERSATION_SCOPED,
  describeCommsError,
  isTestConversation,
  namedTestAgents,
  ownTestAgentRefusal,
  type PolicyAgent,
  type PolicyConversation,
  shapeTestModeValue,
  TEST_AGENT_PREFIX,
  testModeRefusal,
} from "./commsPolicy.ts";

export const COMMS_ROUTE_PREFIX = "/api/comms";
const MAX_WATCH_QUERIES = 32;
const HEARTBEAT = "20 seconds";

export interface CommsSettings {
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

type Args = Record<string, unknown>;

/** The comms deployment as the proxy sees it; tests provide a fake. */
export interface CommsBackendShape {
  /** Undefined when comms isn't configured on this server. */
  readonly settings: CommsSettings | undefined;
  /** The admin token, read now; empty when the file is missing or empty. */
  readonly readToken: Effect.Effect<string>;
  readonly query: (name: string, args: Args) => Promise<unknown>;
  readonly mutation: (name: string, args: Args) => Promise<unknown>;
  readonly subscribe: (
    name: string,
    args: Args,
    onValue: (value: unknown) => void,
    onError: (error: unknown) => void,
  ) => () => void;
}

export class CommsBackend extends Context.Service<CommsBackend, CommsBackendShape>()(
  "t3/comms/CommsProxy/CommsBackend",
) {}

/** The real backend: environment settings, the token file, one shared Convex connection. */
export const layerCommsBackend = Layer.effect(
  CommsBackend,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const settings = resolveCommsSettings();
    let client: ConvexClient | undefined;
    const convex = () => {
      if (!settings) throw new Error("comms isn't configured");
      client ??= new ConvexClient(settings.convexUrl);
      return client;
    };
    yield* Effect.addFinalizer(() => Effect.promise(async () => client?.close()));
    return {
      settings,
      readToken: settings
        ? fs.readFileString(settings.tokenFile).pipe(
            Effect.map((text) => text.trim()),
            Effect.orElseSucceed(() => ""),
          )
        : Effect.succeed(""),
      query: (name, args) => convex().query(makeFunctionReference<"query">(name), args),
      mutation: (name, args) => convex().mutation(makeFunctionReference<"mutation">(name), args),
      subscribe: (name, args, onValue, onError) => {
        const unsubscribe = convex().onUpdate(
          makeFunctionReference<"query">(name),
          args,
          onValue,
          onError,
        );
        return () => unsubscribe();
      },
    } satisfies CommsBackendShape;
  }),
);

class CommsCallError extends Data.TaggedError("CommsCallError")<{
  readonly status: number;
  readonly message: string;
  readonly code?: string;
}> {}

const callError = (status: number, message: string, code?: string): CommsCallError =>
  new CommsCallError({ status, message, ...(code ? { code } : {}) });

const errorResponse = (status: number, message: string, code?: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, ...(code ? { data: { code } } : {}) } },
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
  return body as Args;
});

const asArgs = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};

/** One comms request, with its failure made safe to show (never echoing the token). */
const run = (token: string, call: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) => {
      const described = describeCommsError(error, token);
      return callError(described.code ? 400 : 502, described.message, described.code);
    },
  });

interface Session {
  readonly backend: CommsBackendShape;
  readonly settings: CommsSettings;
  readonly token: string;
}

const openSession = (backend: CommsBackendShape, settings: CommsSettings) =>
  Effect.gen(function* () {
    const token = yield* backend.readToken;
    if (!token) return yield* callError(503, "comms admin token unavailable");
    return { backend, settings, token } satisfies Session;
  });

const query = (session: Session, name: string, args: Args) =>
  run(session.token, () => session.backend.query(name, { ...args, adminToken: session.token }));

/**
 * Test mode: the conversation a scoped call names must be a test conversation.
 * Returns its test agents, which must be this instance's own too.
 */
const requireTestConversation = (session: Session, conversationId: unknown) =>
  Effect.gen(function* () {
    if (typeof conversationId !== "string") {
      return yield* callError(400, "conversationId is required");
    }
    const view = (yield* query(session, "conversations:view", { conversationId, limit: 1 })) as {
      conversation: PolicyConversation;
    };
    if (!isTestConversation(view.conversation, testOptions(session.settings))) {
      return yield* callError(403, "test mode: that conversation isn't a test conversation");
    }
    return view.conversation.members
      .map((member) => member.name)
      .filter((name) => name.startsWith(TEST_AGENT_PREFIX));
  });

/** Test mode: every test agent a call touches must be one this instance owns and homes. */
const requireOwnTestAgents = (session: Session, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (names.length === 0) return;
    const registry = (yield* query(session, "registry:list", {})) as {
      agents: ReadonlyArray<PolicyAgent & { readonly participant: { readonly name: string } }>;
    };
    for (const target of names) {
      const entry = registry.agents.find((agent) => agent.participant.name === target);
      const refusal = ownTestAgentRefusal(target, entry, testOptions(session.settings));
      if (refusal) return yield* callError(403, refusal);
    }
  });

const checkCall = (session: Session, name: string, args: Args) =>
  Effect.gen(function* () {
    if (!session.settings.testMode) return;
    const refusal = testModeRefusal(name, args, testOptions(session.settings));
    if (refusal) return yield* callError(403, refusal);
    const members = CONVERSATION_SCOPED.has(name)
      ? yield* requireTestConversation(session, args.conversationId)
      : [];
    yield* requireOwnTestAgents(session, [
      ...new Set([...namedTestAgents(name, args), ...members]),
    ]);
  });

/** A query's value as the page may see it (test mode shapes and rechecks it). */
const shape = (settings: CommsSettings, name: string, value: unknown) =>
  settings.testMode ? shapeTestModeValue(name, value, testOptions(settings)) : { value };

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

const callHandler = (backend: CommsBackendShape, settings: CommsSettings) =>
  Effect.gen(function* () {
    const body = yield* readJsonObject;
    const fn = yield* resolveFunction(body.name, body.kind);
    yield* authenticateHttpRequestScope(
      fn.kind === "mutation" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    );
    const session = yield* openSession(backend, settings);
    const args = asArgs(body.args);
    yield* checkCall(session, fn.name, args);
    if (fn.kind === "mutation") {
      const value = yield* run(session.token, () =>
        backend.mutation(fn.name, { ...args, adminToken: session.token }),
      );
      return HttpServerResponse.jsonUnsafe({ value });
    }
    const shaped = shape(settings, fn.name, yield* query(session, fn.name, args));
    if ("error" in shaped) return yield* callError(403, shaped.error);
    return HttpServerResponse.jsonUnsafe({ value: shaped.value });
  });

interface WatchQuery {
  readonly id: string;
  readonly name: string;
  readonly args: Args;
}

const watchHandler = (backend: CommsBackendShape, settings: CommsSettings) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    const body = yield* readJsonObject;
    const raw = body.queries;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WATCH_QUERIES) {
      return yield* callError(400, `"queries" must list 1-${MAX_WATCH_QUERIES} queries`);
    }
    const queries: WatchQuery[] = [];
    const ids = new Set<string>();
    for (const entry of raw) {
      const q = asArgs(entry);
      if (typeof q.id !== "string" || q.id.length > 512) {
        return yield* callError(400, "each query needs a string id");
      }
      if (ids.has(q.id)) return yield* callError(400, `query id ${q.id} appears twice`);
      ids.add(q.id);
      const fn = yield* resolveFunction(q.name, "query");
      queries.push({ id: q.id, name: fn.name, args: asArgs(q.args) });
    }
    const session = yield* openSession(backend, settings);
    // Arguments are checked once, up front; values are rechecked on every update (shape).
    const refused = new Map<string, { message: string }>();
    for (const q of queries) {
      const check = yield* Effect.result(checkCall(session, q.name, q.args));
      if (check._tag === "Failure") refused.set(q.id, { message: check.failure.message });
    }

    const encoder = new TextEncoder();
    const frame = (line: unknown) => encoder.encode(`${JSON.stringify(line)}\n`);
    const frames = Stream.callback<Uint8Array>((queue) =>
      Effect.gen(function* () {
        const offer = (line: unknown) => Queue.offerUnsafe(queue, frame(line));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const stops = new Map<string, () => void>();
            // A subscription that throws while starting releases the ones already open.
            try {
              for (const q of queries) {
                const refusal = refused.get(q.id);
                if (refusal) {
                  offer({ id: q.id, error: refusal });
                  continue;
                }
                const stop = backend.subscribe(
                  q.name,
                  { ...q.args, adminToken: session.token },
                  (value) => {
                    const shaped = shape(settings, q.name, value);
                    if ("value" in shaped) {
                      offer({ id: q.id, value: shaped.value });
                      return;
                    }
                    // No longer allowed: say so once and stop following it.
                    offer({ id: q.id, error: { message: shaped.error } });
                    stops.get(q.id)?.();
                    stops.delete(q.id);
                  },
                  (error) => offer({ id: q.id, error: describeCommsError(error, session.token) }),
                );
                stops.set(q.id, stop);
              }
            } catch (cause) {
              stops.forEach((stop) => stop());
              throw cause;
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
  const backend = yield* CommsBackend;
  const settings = backend.settings;
  if (!settings) return errorResponse(404, "comms isn't configured on this server");
  const route = url.value.pathname.slice(COMMS_ROUTE_PREFIX.length);
  const method =
    route === "/config" ? "GET" : route === "/call" || route === "/watch" ? "POST" : null;
  if (!method) return errorResponse(404, "no such comms endpoint");
  if (request.method !== method) return errorResponse(405, `${method} only`);
  const response =
    route === "/config"
      ? configHandler(settings)
      : route === "/call"
        ? callHandler(backend, settings)
        : watchHandler(backend, settings);
  return yield* response.pipe(
    Effect.catchTags({
      CommsCallError: (error) =>
        Effect.succeed(errorResponse(error.status, error.message, error.code)),
    }),
  );
});

/** The routes, built over a CommsBackend (tests provide a fake). */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const backend = yield* CommsBackend;
    return HttpRouter.add(
      "*",
      `${COMMS_ROUTE_PREFIX}/*`,
      handler.pipe(Effect.provideService(CommsBackend, backend)),
    );
  }),
);

/** The routes over the real backend, as the server mounts them. */
export const layer = routeLayer.pipe(Layer.provide(layerCommsBackend));
