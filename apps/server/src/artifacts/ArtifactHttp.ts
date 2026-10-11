// Fork-only (artifacts): the /api/artifacts routes, registered in server.ts.
// Callers authenticate with their T3 session (cookie or bearer) as on the comms
// routes: reads need `orchestration:read`, writes `orchestration:operate`.
// Deliberately not `filesystem:read`, so every paired device can open them.
//
//   GET    /api/artifacts                        list (?thread= &tag= &folder= &kind= &q=)
//   POST   /api/artifacts                        create a markdown artifact
//   POST   /api/artifacts/watch                  NDJSON change stream
//   GET    /api/artifacts/:id                    metadata, content, list items, links
//   POST   /api/artifacts/:id/ops                list ops
//   POST   /api/artifacts/:id/links              attach to a thread
//   DELETE /api/artifacts/:id/links/:threadId    detach
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  LIM_ARTIFACT_MAX_OPS,
  LIM_ARTIFACT_MAX_WATCH_IDS,
  LIM_ARTIFACTS_ROUTE_PREFIX,
  LimArtifactAttachRequest,
  LimArtifactCreateRequest,
  LimArtifactKind,
  LimArtifactOpsRequest,
  LimArtifactWatchRequest,
  type LimArtifactActor,
  type LimArtifactStoreInfo,
  type LimArtifactWatchFrame,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateHttpRequestScope } from "../comms/commsAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ARTIFACTS_USER_NAME, resolveArtifactsDir } from "./artifactConfig.ts";
import { ArtifactPathError, ULID_PATTERN } from "./ArtifactFiles.ts";
import { ArtifactStore, ArtifactStoreError } from "./ArtifactStore.ts";

const HEARTBEAT = "20 seconds";
/** A watcher this far behind gets `{resync}` instead of every change. */
const MAX_PENDING_FRAMES = 1000;

export interface ArtifactStoreHandleShape {
  readonly dir: string;
  /** The open store; opening is retried after a failure. */
  readonly store: Effect.Effect<ArtifactStore, ArtifactStoreError>;
}

export class ArtifactStoreHandle extends Context.Service<
  ArtifactStoreHandle,
  ArtifactStoreHandleShape
>()("t3/artifacts/ArtifactHttp/ArtifactStoreHandle") {}

/** A store handle for `dir`, opened right away (the startup scan) and closed with the layer. */
export const makeStoreHandle = (dir: string) =>
  Effect.gen(function* () {
    let opening: Promise<ArtifactStore> | undefined;
    const open = () => {
      opening ??= ArtifactStore.open(dir).catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
      return opening;
    };
    // The startup scan runs now, in the background; a failure is logged and the
    // routes answer 503 until a later request opens the store.
    yield* Effect.tryPromise(open).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("artifact store failed to open", { dir, error }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const store = await opening?.catch(() => undefined);
        store?.close();
      }),
    );
    return {
      dir,
      store: Effect.tryPromise({
        try: open,
        catch: (error) =>
          new ArtifactStoreError(
            "unavailable",
            `the artifact store couldn't open: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
    } satisfies ArtifactStoreHandleShape;
  });

export const layerStoreHandle = Layer.effect(
  ArtifactStoreHandle,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeStoreHandle(resolveArtifactsDir(config));
  }),
);

class ArtifactHttpError extends Data.TaggedError("ArtifactHttpError")<{
  readonly status: number;
  readonly message: string;
  readonly code: string;
  readonly currentRevision?: string | undefined;
  /** The unexpected failure behind a 500, for the server log only. */
  readonly failure?: unknown;
}> {}

const STATUS: Record<ArtifactStoreError["code"], number> = {
  not_found: 404,
  item_not_found: 404,
  invalid_request: 400,
  invalid_path: 400,
  too_large: 413,
  unavailable: 503,
};

const httpError = (status: number, code: string, message: string) =>
  new ArtifactHttpError({ status, code, message });

const errorResponse = (error: ArtifactHttpError) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        message: error.message,
        code: error.code,
        ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
      },
    },
    { status: error.status },
  );

/** A store call, with its failures made into HTTP errors. */
const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof ArtifactStoreError) {
        return new ArtifactHttpError({
          status: STATUS[error.code],
          code: error.code,
          message: error.message,
          currentRevision: error.currentRevision,
        });
      }
      if (error instanceof ArtifactPathError) return httpError(400, error.code, error.message);
      return new ArtifactHttpError({
        status: 500,
        code: "internal_error",
        message: "the artifact store failed; see the server log",
        failure: error,
      });
    },
  }).pipe(
    Effect.tapError((error) =>
      error.status === 500
        ? Effect.logError("artifact store request failed", error.failure)
        : Effect.void,
    ),
  );

const openStore = Effect.gen(function* () {
  const handle = yield* ArtifactStoreHandle;
  return yield* handle.store.pipe(
    Effect.mapError((error) => httpError(503, error.code, error.message)),
  );
});

const readBody = <S extends Schema.Top>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.mapError(() => httpError(400, "invalid_request", "the body must be JSON")),
    );
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() =>
        httpError(400, "invalid_request", "the body doesn't match the artifacts request schema"),
      ),
    );
  });

/** Who a request acts as: Lee, through a T3 session. */
const userActor = (subject: string): LimArtifactActor => ({
  kind: "user",
  id: subject,
  name: ARTIFACTS_USER_NAME,
});

const storeInfo = Effect.gen(function* () {
  const handle = yield* ArtifactStoreHandle;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  return {
    environmentId: descriptor.environmentId,
    environmentName: descriptor.label,
    storeDir: handle.dir,
  } satisfies LimArtifactStoreInfo;
});

const isArtifactKind = Schema.is(LimArtifactKind);

const listHandler = (url: URL) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    const store = yield* openStore;
    const params = url.searchParams;
    const kind = params.get("kind");
    if (kind !== null && !isArtifactKind(kind)) {
      return yield* httpError(400, "invalid_request", "kind must be md, html or other");
    }
    const artifacts = yield* call(() =>
      store.list({
        threadId: params.get("thread") ?? undefined,
        tag: params.get("tag") ?? undefined,
        folder: params.get("folder") ?? undefined,
        kind: kind ?? undefined,
        query: params.get("q") ?? undefined,
      }),
    );
    return HttpServerResponse.jsonUnsafe({ store: yield* storeInfo, artifacts });
  });

const createHandler = Effect.gen(function* () {
  const session = yield* authenticateHttpRequestScope(AuthOrchestrationOperateScope);
  const body = yield* readBody(LimArtifactCreateRequest);
  const store = yield* openStore;
  const created = yield* call(() => store.create(body, userActor(session.subject)));
  return HttpServerResponse.jsonUnsafe({ store: yield* storeInfo, ...created }, { status: 201 });
});

const readHandler = (id: string) =>
  Effect.gen(function* () {
    yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
    const store = yield* openStore;
    const result = yield* call(() => store.read(id));
    return HttpServerResponse.jsonUnsafe({ store: yield* storeInfo, ...result });
  });

const opsHandler = (id: string) =>
  Effect.gen(function* () {
    const session = yield* authenticateHttpRequestScope(AuthOrchestrationOperateScope);
    const body = yield* readBody(LimArtifactOpsRequest);
    if (body.ops.length > LIM_ARTIFACT_MAX_OPS) {
      return yield* httpError(
        400,
        "invalid_request",
        `at most ${LIM_ARTIFACT_MAX_OPS} ops at once`,
      );
    }
    const store = yield* openStore;
    const result = yield* call(() => store.applyOps(id, body.ops, userActor(session.subject)));
    return HttpServerResponse.jsonUnsafe(result);
  });

const attachHandler = (id: string) =>
  Effect.gen(function* () {
    const session = yield* authenticateHttpRequestScope(AuthOrchestrationOperateScope);
    const body = yield* readBody(LimArtifactAttachRequest);
    const store = yield* openStore;
    const artifact = yield* call(() =>
      store.attach(id, body.threadId, body.access ?? "write", userActor(session.subject)),
    );
    return HttpServerResponse.jsonUnsafe({ artifact });
  });

const detachHandler = (id: string, threadId: string) =>
  Effect.gen(function* () {
    const session = yield* authenticateHttpRequestScope(AuthOrchestrationOperateScope);
    const store = yield* openStore;
    const artifact = yield* call(() => store.detach(id, threadId, userActor(session.subject)));
    return HttpServerResponse.jsonUnsafe({ artifact });
  });

const watchHandler = Effect.gen(function* () {
  yield* authenticateHttpRequestScope(AuthOrchestrationReadScope);
  const body = yield* readBody(LimArtifactWatchRequest);
  const ids = body.ids === undefined ? undefined : new Set(body.ids);
  if (ids && (ids.size === 0 || ids.size > LIM_ARTIFACT_MAX_WATCH_IDS)) {
    return yield* httpError(
      400,
      "invalid_request",
      `"ids" must list 1-${LIM_ARTIFACT_MAX_WATCH_IDS} ids`,
    );
  }
  const store = yield* openStore;
  const encoder = new TextEncoder();
  let pending = 0;
  let overflowed = false;
  const frames = Stream.callback<LimArtifactWatchFrame>((queue) =>
    Effect.gen(function* () {
      const offer = (frame: LimArtifactWatchFrame) => {
        if (overflowed) return;
        pending++;
        if (pending > MAX_PENDING_FRAMES) {
          overflowed = true;
          Queue.offerUnsafe(queue, { resync: true });
          return;
        }
        Queue.offerUnsafe(queue, frame);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = store.subscribe((change) => {
            if (!ids || ids.has(change.artifactId)) offer({ change });
          });
          // Subscribe first, then announce the ready seq to avoid dropping events.
          offer({ ready: { seq: store.lastSeq() } });
          return unsubscribe;
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      // Heartbeats keep idle streams open through proxies.
      yield* Effect.sync(() => offer({})).pipe(
        Effect.repeat(Schedule.spaced(HEARTBEAT)),
        Effect.delay(HEARTBEAT),
        Effect.forkScoped,
      );
    }),
  ).pipe(
    Stream.map((frame) => {
      pending--;
      // The reader has caught up with the resync marker: deliver again.
      if ("resync" in frame) {
        pending = 0;
        overflowed = false;
      }
      return encoder.encode(`${JSON.stringify(frame)}\n`);
    }),
  );
  return HttpServerResponse.stream(frames, {
    contentType: "application/x-ndjson; charset=utf-8",
    headers: { "cache-control": "no-store" },
  });
});

const notFound = () =>
  Effect.succeed(errorResponse(httpError(404, "not_found", "no such artifacts endpoint")));

const methodNotAllowed = (method: string) =>
  Effect.succeed(errorResponse(httpError(405, "method_not_allowed", `${method} only`)));

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** The handler for one request, by method and path below the prefix. */
const dispatch = (method: string, url: URL) => {
  const segments = url.pathname
    .slice(LIM_ARTIFACTS_ROUTE_PREFIX.length)
    .split("/")
    .filter(Boolean)
    .map(decodeSegment);
  if (segments.some((segment) => segment === null)) return notFound();
  const [first, second, third, ...rest] = segments as string[];
  if (first === undefined) {
    if (method === "GET") return listHandler(url);
    return method === "POST" ? createHandler : methodNotAllowed("GET or POST");
  }
  if (first === "watch" && second === undefined) {
    return method === "POST" ? watchHandler : methodNotAllowed("POST");
  }
  if (!ULID_PATTERN.test(first)) return notFound();
  if (second === undefined) return method === "GET" ? readHandler(first) : methodNotAllowed("GET");
  if (second === "ops" && third === undefined) {
    return method === "POST" ? opsHandler(first) : methodNotAllowed("POST");
  }
  if (second === "links" && third === undefined) {
    return method === "POST" ? attachHandler(first) : methodNotAllowed("POST");
  }
  if (second === "links" && third !== undefined && rest.length === 0) {
    return method === "DELETE" ? detachHandler(first, third) : methodNotAllowed("DELETE");
  }
  return notFound();
};

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  return yield* dispatch(request.method, url.value).pipe(
    Effect.catchTags({ ArtifactHttpError: (error) => Effect.succeed(errorResponse(error)) }),
  );
});

/** The routes over whatever store handle is provided (tests provide a temp store). */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const handle = yield* ArtifactStoreHandle;
    // The wildcard route also matches the bare prefix (the list and create routes).
    return HttpRouter.add(
      "*",
      `${LIM_ARTIFACTS_ROUTE_PREFIX}/*`,
      handler.pipe(Effect.provideService(ArtifactStoreHandle, handle)),
    );
  }),
);

/** The routes over the store at `<baseDir>/artifacts`, as the server mounts them. */
export const layer = routeLayer.pipe(Layer.provide(layerStoreHandle));
