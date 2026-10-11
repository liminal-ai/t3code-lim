// Fork-only (artifacts): signed view links (PROPOSAL §2.7). A token opens one
// artifact at `/a/<token>` without a T3 session until it expires. It is
// `<payload>.<signature>`: the payload is base64url JSON naming the artifact,
// when the token was issued and when it expires; the signature is an HMAC of
// the payload with the server secret `lim-artifacts-view-key`. Nothing else
// signs with that secret. No token lives longer than 7 days, and the server
// refuses one that claims to.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import {
  LIM_ARTIFACT_VIEW_MAX_SECONDS,
  LIM_ARTIFACT_VIEW_ROUTE_PREFIX,
  LIM_ARTIFACT_VIEW_VIEWER_SECONDS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../auth/utils.ts";
import { ULID_PATTERN } from "./ArtifactFiles.ts";

export const VIEW_KEY_SECRET_NAME = "lim-artifacts-view-key";

export interface ViewClaims {
  readonly artifactId: string;
  /** Epoch seconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type ViewTokenFailure = "malformed" | "bad_signature" | "expired" | "too_long";

export class ViewLinkLifetimeError extends Error {
  readonly code = "invalid_request";
}

/** The lifetime a caller asked for, in seconds: one hour by default, at most 7 days. */
export const viewLifetime = (requested: number | undefined) => {
  const seconds = requested ?? LIM_ARTIFACT_VIEW_VIEWER_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > LIM_ARTIFACT_VIEW_MAX_SECONDS) {
    throw new ViewLinkLifetimeError(
      `a view link lives 1 second to 7 days (${LIM_ARTIFACT_VIEW_MAX_SECONDS} seconds)`,
    );
  }
  return seconds;
};

export const signViewToken = (secret: Uint8Array, claims: ViewClaims) => {
  const payload = base64UrlEncode(
    JSON.stringify({ a: claims.artifactId, i: claims.issuedAt, e: claims.expiresAt }),
  );
  return `${payload}.${signPayload(payload, secret)}`;
};

/** The artifact a token opens at `nowSeconds`, or why it opens nothing. */
export const verifyViewToken = (
  secret: Uint8Array,
  token: string,
  nowSeconds: number,
): { readonly artifactId: string } | { readonly failure: ViewTokenFailure } => {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { failure: "malformed" };
  // Compared as text, not decoded bytes: base64url's last character has
  // unused bits, so several spellings decode to the same signature, and only
  // the one this server wrote may open anything.
  const expected = Buffer.from(signPayload(payload, secret));
  const presented = Buffer.from(signature);
  if (presented.length !== expected.length || !NodeCrypto.timingSafeEqual(presented, expected)) {
    return { failure: "bad_signature" };
  }
  let claims: { a?: unknown; i?: unknown; e?: unknown };
  try {
    claims = JSON.parse(base64UrlDecodeUtf8(payload)) as typeof claims;
  } catch {
    return { failure: "malformed" };
  }
  const { a: artifactId, i: issuedAt, e: expiresAt } = claims ?? {};
  if (
    typeof artifactId !== "string" ||
    !ULID_PATTERN.test(artifactId) ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number"
  ) {
    return { failure: "malformed" };
  }
  if (expiresAt - issuedAt > LIM_ARTIFACT_VIEW_MAX_SECONDS) return { failure: "too_long" };
  if (expiresAt <= nowSeconds) return { failure: "expired" };
  return { artifactId };
};

const viewKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(VIEW_KEY_SECRET_NAME, 32);
});

/** A view link for one artifact: the URL relative to the server, and when it expires. */
export const issueViewUrl = Effect.fn("ArtifactViewTokens.issueViewUrl")(function* (
  artifactId: string,
  lifetimeSeconds: number,
) {
  const secret = yield* viewKey;
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const expiresAt = issuedAt + lifetimeSeconds;
  return {
    url: `${LIM_ARTIFACT_VIEW_ROUTE_PREFIX}/${signViewToken(secret, { artifactId, issuedAt, expiresAt })}`,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1000)),
  };
});

/** The artifact a presented token opens, or why it doesn't. */
export const resolveViewToken = Effect.fn("ArtifactViewTokens.resolveViewToken")(function* (
  token: string,
) {
  const secret = yield* viewKey;
  const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return verifyViewToken(secret, token, nowSeconds);
});
