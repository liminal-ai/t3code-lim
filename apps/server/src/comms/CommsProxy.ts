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
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  COMMS_FUNCTIONS,
  COMMS_MAX_WATCH_QUERIES,
  CommsCallRequest,
  type CommsConfig,
  type CommsWatchFrame,
  type CommsWireError,
  CommsWatchRequest,
  isCommsFunctionName,
} from "@t3tools/contracts";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateHttpRequestScope } from "./commsAuth.ts";
import {
  CONVERSATION_SCOPED,
  CONVERSATIONS_SCOPED,
  describeCommsError,
  isTestConversation,
  namedTestAgents,
  ownTestAgentRefusal,
  ownTestAgents,
  type PolicyAgent,
  type PolicyConversation,
  shapeTestModeValue,
  TEST_AGENT_PREFIX,
  testModeRefusal,
} from "./commsPolicy.ts";

export const COMMS_ROUTE_PREFIX = "/api/comms";
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

/** A comms failure in the wire's error shape (a refusal keeps its code in `data`). */
const wireError = (error: unknown, token: string): CommsWireError => {
  const described = describeCommsError(error, token);
  return described.code
    ? { message: described.message, data: { code: described.code } }
    : { message: described.message };
};

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

/** The request body, decoded with its contracts schema. */
const readBody = <S extends Schema.Top>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.mapError(() => callError(400, "the body must be JSON")),
    );
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => callError(400, "the body doesn't match the comms request schema")),
    );
  });

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
    const members: string[] = CONVERSATION_SCOPED.has(name)
      ? [...(yield* requireTestConversation(session, args.conversationId))]
      : [];
    if (CONVERSATIONS_SCOPED.has(name)) {
      for (const conversationId of args.conversationIds as ReadonlyArray<string>) {
        members.push(...(yield* requireTestConversation(session, conversationId)));
      }
    }
    yield* requireOwnTestAgents(session, [
      ...new Set([...namedTestAgents(name, args), ...members]),
    ]);
  });

type RegistryAgents = ReadonlyArray<
  PolicyAgent & { readonly participant: { readonly name: string } }
>;

/** Test mode: the test agents this instance owns and homes, from the registry now. */
const loadOwnAgents = (session: Session) =>
  Effect.map(query(session, "registry:list", {}), (registry) =>
    ownTestAgents((registry as { agents: RegistryAgents }).agents, testOptions(session.settings)),
  );

/**
 * A query's value as the page may see it. Test mode shapes and rechecks every
 * value, counting only this instance's own test agents as test participants.
 */
const shape = (
  settings: CommsSettings,
  name: string,
  value: unknown,
  ownAgents: ReadonlySet<string> | undefined,
) =>
  settings.testMode
    ? shapeTestModeValue(name, value, { ...testOptions(settings), ownAgents })
    : { value };

const sameNames = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((name) => b.has(name));

/** Queries whose values test mode filters by conversation membership. */
const MEMBERSHIP_SHAPED = new Set(["conversations:list", "conversations:view"]);

const resolveFunction = (name: string, kind?: string) => {
  if (!isCommsFunctionName(name)) {
    return Effect.fail(callError(404, `no comms function ${name}`));
  }
  const actual = COMMS_FUNCTIONS[name];
  if (kind !== undefined && kind !== actual) {
    return Effect.fail(callError(400, `${name} is a ${actual}`));
  }
  return Effect.succeed({ name, kind: actual });
};

const configHandler = (settings: CommsSettings) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    const config: CommsConfig = {
      enabled: true,
      testMode: settings.testMode,
      postAs: settings.postAs ?? null,
      homeMachine: settings.homeMachine ?? null,
    };
    return HttpServerResponse.jsonUnsafe(config);
  });

const callHandler = (backend: CommsBackendShape, settings: CommsSettings) =>
  Effect.gen(function* () {
    const body = yield* readBody(CommsCallRequest);
    const fn = yield* resolveFunction(body.name, body.kind);
    yield* authenticateHttpRequestScope(
      fn.kind === "mutation" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    );
    const session = yield* openSession(backend, settings);
    const args = { ...body.args };
    yield* checkCall(session, fn.name, args);
    if (fn.kind === "mutation") {
      const value = yield* run(session.token, () =>
        backend.mutation(fn.name, { ...args, adminToken: session.token }),
      );
      return HttpServerResponse.jsonUnsafe({ value });
    }
    const ownAgents =
      settings.testMode && MEMBERSHIP_SHAPED.has(fn.name)
        ? yield* loadOwnAgents(session)
        : undefined;
    const shaped = shape(settings, fn.name, yield* query(session, fn.name, args), ownAgents);
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
    const body = yield* readBody(CommsWatchRequest);
    if (body.queries.length === 0 || body.queries.length > COMMS_MAX_WATCH_QUERIES) {
      return yield* callError(400, `"queries" must list 1-${COMMS_MAX_WATCH_QUERIES} queries`);
    }
    const queries: WatchQuery[] = [];
    const ids = new Set<string>();
    for (const q of body.queries) {
      if (q.id.length > 512) return yield* callError(400, "a query id is at most 512 characters");
      if (ids.has(q.id)) return yield* callError(400, `query id ${q.id} appears twice`);
      ids.add(q.id);
      const fn = yield* resolveFunction(q.name, "query");
      queries.push({ id: q.id, name: fn.name, args: { ...q.args } });
    }
    const session = yield* openSession(backend, settings);
    // Arguments are checked once, up front; values are rechecked on every update (shape).
    const refused = new Map<string, { message: string }>();
    for (const q of queries) {
      const check = yield* Effect.result(checkCall(session, q.name, q.args));
      if (check._tag === "Failure") refused.set(q.id, { message: check.failure.message });
    }
    // Membership can change while a watch is open (a member added or rebound elsewhere):
    // test mode follows the registry too, and rechecks every value against it.
    const followRegistry = settings.testMode && queries.some((q) => MEMBERSHIP_SHAPED.has(q.name));
    let ownAgents = followRegistry ? yield* loadOwnAgents(session) : undefined;

    const encoder = new TextEncoder();
    const frame = (line: unknown) => encoder.encode(`${JSON.stringify(line)}\n`);
    // Frames are coalesced per query: while the client hasn't read a query's last
    // frame, a newer one replaces it. The queue holds at most one key per query (plus
    // the heartbeat), so a slow client costs at most one pending frame per query.
    const pending = new Map<string, unknown>();
    const keys = Stream.callback<string>((queue) =>
      Effect.gen(function* () {
        const offerAs = (key: string, line: unknown) => {
          const queued = pending.has(key);
          pending.set(key, line);
          if (!queued) Queue.offerUnsafe(queue, key);
        };
        // Query frames key as `q:<id>` and the heartbeat as `h`, so no client id can collide.
        const offer = (line: CommsWatchFrame) => offerAs("id" in line ? `q:${line.id}` : "h", line);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const stops = new Map<string, () => void>();
            let stopRegistry: (() => void) | undefined;
            const stopAll = () => {
              stopRegistry?.();
              stops.forEach((stop) => stop());
            };
            const latest = new Map<string, unknown>();
            const forward = (q: WatchQuery, value: unknown) => {
              latest.set(q.id, value);
              const shaped = shape(settings, q.name, value, ownAgents);
              if ("value" in shaped) {
                offer({ id: q.id, value: shaped.value });
                return;
              }
              // No longer allowed: say so once and stop following it.
              offer({ id: q.id, error: { message: shaped.error } });
              stops.get(q.id)?.();
              stops.delete(q.id);
              latest.delete(q.id);
            };
            // A subscription that throws while starting releases the ones already open.
            try {
              if (followRegistry) {
                // Kept apart from the client's query ids, which can be any string.
                stopRegistry = backend.subscribe(
                  "registry:list",
                  { adminToken: session.token },
                  (registry) => {
                    const next = ownTestAgents(
                      (registry as { agents: RegistryAgents }).agents,
                      testOptions(settings),
                    );
                    // Most registry updates (presence) don't change who's ours: resend nothing.
                    if (ownAgents && sameNames(ownAgents, next)) return;
                    ownAgents = next;
                    for (const q of queries) {
                      if (MEMBERSHIP_SHAPED.has(q.name) && latest.has(q.id)) {
                        forward(q, latest.get(q.id));
                      }
                    }
                  },
                  () => undefined,
                );
              }
              for (const q of queries) {
                const refusal = refused.get(q.id);
                if (refusal) {
                  offer({ id: q.id, error: refusal });
                  continue;
                }
                const stop = backend.subscribe(
                  q.name,
                  { ...q.args, adminToken: session.token },
                  (value) => forward(q, value),
                  (error) => offer({ id: q.id, error: wireError(error, session.token) }),
                );
                stops.set(q.id, stop);
              }
            } catch (cause) {
              stopAll();
              throw cause;
            }
            return stopAll;
          }),
          (stopAll) => Effect.sync(stopAll),
        );
        // Heartbeats keep idle streams open through proxies.
        yield* Effect.sync(() => offer({})).pipe(
          Effect.repeat(Schedule.spaced(HEARTBEAT)),
          Effect.forkScoped,
        );
      }),
    );
    const frames = keys.pipe(
      Stream.map((key) => {
        const line = pending.get(key);
        pending.delete(key);
        return frame(line);
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
