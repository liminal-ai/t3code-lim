// Fork-only (artifacts): the page's client for one environment's /api/artifacts
// routes (apps/server/src/artifacts/ArtifactHttp.ts). Credentials are the same as
// the comms client's: the session cookie for a same-origin browser, the desktop
// bearer for the desktop's own server, and a remote environment's own bearer.
import {
  LIM_ARTIFACTS_ROUTE_PREFIX,
  type LimArtifactCreateRequest,
  type LimArtifactListOp,
  LimArtifactListResponse,
  LimArtifactOpsResponse,
  LimArtifactReadResponse,
  LimArtifactViewUrlResponse,
  LimArtifactWireError,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { isSameOriginBrowserPrimary } from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

import type { ArtifactsRoute } from "./artifactsRoute.logic";

export class ArtifactsError extends Error {
  /** The HTTP status; 0 when the request never got an answer. */
  readonly status: number;
  readonly code: string;
  /** Sent with `item_not_found`, so the caller can re-read. */
  readonly currentRevision: string | undefined;
  constructor(message: string, status: number, code: string, currentRevision?: string) {
    super(message);
    this.name = "ArtifactsError";
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

/** An absolute URL on the environment's server, for a path such as a view link's `/a/<token>`. */
export function artifactsServerUrl(route: ArtifactsRoute, path: string): string {
  return route.kind === "environment"
    ? new URL(path, route.baseUrl).toString()
    : resolvePrimaryEnvironmentHttpUrl(path);
}

export async function artifactsFetch(
  route: ArtifactsRoute,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const [pathname = "", query] = path.split("?", 2);
  const target =
    route.kind === "environment"
      ? new URL(`${LIM_ARTIFACTS_ROUTE_PREFIX}${path}`, route.baseUrl).toString()
      : resolvePrimaryEnvironmentHttpUrl(
          `${LIM_ARTIFACTS_ROUTE_PREFIX}${pathname}`,
          query === undefined ? undefined : Object.fromEntries(new URLSearchParams(query)),
        );
  const bearer =
    route.kind === "environment"
      ? route.bearer
      : isSameOriginBrowserPrimary()
        ? null
        : await readDesktopPrimaryBearerToken();
  if (bearer === null) return fetch(target, { ...init, headers, credentials: "include" });
  headers.set("authorization", `Bearer ${bearer}`);
  return fetch(target, { ...init, headers, credentials: "omit" });
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: LimArtifactWireError }));

/** The server's `{error}` body as an ArtifactsError, or a generic one for its status. */
export async function readArtifactsError(response: Response): Promise<ArtifactsError> {
  const body = decodeErrorBody(await response.json().catch(() => null));
  if (body._tag === "Some") {
    const { message, code, currentRevision } = body.value.error;
    return new ArtifactsError(message, response.status, code, currentRevision);
  }
  return new ArtifactsError(
    response.status === 404
      ? "this T3 server has no artifact store"
      : `the artifacts request failed (${response.status})`,
    response.status,
    "http_error",
  );
}

async function request<A>(
  route: ArtifactsRoute,
  path: string,
  decode: (input: unknown) => Option.Option<A>,
  init: RequestInit = {},
): Promise<A> {
  let response: Response;
  try {
    response = await artifactsFetch(route, path, init);
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new ArtifactsError("couldn't reach the T3 server", 0, "network");
  }
  if (!response.ok) throw await readArtifactsError(response);
  const decoded = decode(await response.json().catch(() => null));
  if (Option.isNone(decoded)) {
    throw new ArtifactsError("the server answered in an unknown shape", 502, "bad_response");
  }
  return decoded.value;
}

const decodeList = Schema.decodeUnknownOption(LimArtifactListResponse);
const decodeRead = Schema.decodeUnknownOption(LimArtifactReadResponse);
const decodeOps = Schema.decodeUnknownOption(LimArtifactOpsResponse);
const decodeViewUrl = Schema.decodeUnknownOption(LimArtifactViewUrlResponse);

const postJson = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  ...(signal ? { signal } : {}),
});

export const listArtifacts = (route: ArtifactsRoute, signal?: AbortSignal) =>
  request(route, "", decodeList, signal ? { signal } : {});

export const readArtifact = (route: ArtifactsRoute, id: string) =>
  request(route, `/${encodeURIComponent(id)}`, decodeRead);

/** The create response has the read response's shape. */
export const createArtifact = (route: ArtifactsRoute, body: LimArtifactCreateRequest) =>
  request(route, "", decodeRead, postJson(body));

export const applyArtifactOps = (
  route: ArtifactsRoute,
  id: string,
  ops: ReadonlyArray<LimArtifactListOp>,
) => request(route, `/${encodeURIComponent(id)}/ops`, decodeOps, postJson({ ops }));

/**
 * Uploads a file as a new artifact in `folder` (the store's top when omitted).
 * Its name's extension picks the kind; the response has the read response's shape.
 */
export const uploadArtifact = (
  route: ArtifactsRoute,
  file: File,
  options: { readonly folder?: string } = {},
) => {
  const params = new URLSearchParams({ name: file.name });
  if (options.folder) params.set("folder", options.folder);
  return request(route, `?${params.toString()}`, decodeRead, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
};

/** A signed link that opens the artifact without a session for `expiresInSeconds`. */
export const createArtifactViewUrl = async (
  route: ArtifactsRoute,
  id: string,
  expiresInSeconds: number,
) => {
  const minted = await request(
    route,
    `/${encodeURIComponent(id)}/view-url`,
    decodeViewUrl,
    postJson({ expiresInSeconds }),
  );
  return { url: artifactsServerUrl(route, minted.url), expiresAt: minted.expiresAt };
};

/** Opens the change stream for every artifact (ids omitted). */
export const openArtifactsWatch = (route: ArtifactsRoute, signal: AbortSignal) =>
  artifactsFetch(route, "/watch", postJson({}, signal));
