// Fork-only (artifacts): tests for signed view link tokens.
import { describe, expect, it } from "vite-plus/test";

import {
  signViewToken,
  verifyViewToken,
  viewLifetime,
  ViewLinkLifetimeError,
} from "./ArtifactViewTokens.ts";

const KEY = new Uint8Array(32).fill(1);
const OTHER_KEY = new Uint8Array(32).fill(2);
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;

const token = (claims: { issuedAt?: number; expiresAt?: number; artifactId?: string } = {}) =>
  signViewToken(KEY, {
    artifactId: claims.artifactId ?? ID,
    issuedAt: claims.issuedAt ?? NOW,
    expiresAt: claims.expiresAt ?? NOW + HOUR,
  });

describe("view tokens", () => {
  it("open the artifact they were signed for until they expire", () => {
    expect(verifyViewToken(KEY, token(), NOW)).toEqual({ artifactId: ID });
    expect(verifyViewToken(KEY, token(), NOW + HOUR - 1)).toEqual({ artifactId: ID });
    expect(verifyViewToken(KEY, token(), NOW + HOUR)).toEqual({ failure: "expired" });
  });

  it("fail when tampered with, or signed with another key", () => {
    const [payload, signature] = token().split(".") as [string, string];
    // Another artifact's claims under the first token's signature.
    const [otherPayload] = token({ artifactId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" }).split(".");
    expect(verifyViewToken(KEY, `${otherPayload}.${signature}`, NOW)).toEqual({
      failure: "bad_signature",
    });
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    expect(verifyViewToken(KEY, `${payload}.${flipped}`, NOW)).toEqual({
      failure: "bad_signature",
    });
    expect(verifyViewToken(OTHER_KEY, token(), NOW)).toEqual({ failure: "bad_signature" });
    // The last character's unused low bits: decodes to the same bytes, but isn't what was signed.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1)!);
    const respelled = `${signature.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(respelled, "base64url")).toEqual(Buffer.from(signature, "base64url"));
    expect(verifyViewToken(KEY, `${payload}.${respelled}`, NOW)).toEqual({
      failure: "bad_signature",
    });
    expect(verifyViewToken(KEY, payload, NOW)).toEqual({ failure: "malformed" });
    expect(verifyViewToken(KEY, `${token()}.extra`, NOW)).toEqual({ failure: "malformed" });
  });

  it("refuse a token that claims to live longer than 7 days", () => {
    expect(verifyViewToken(KEY, token({ expiresAt: NOW + 7 * DAY }), NOW)).toEqual({
      artifactId: ID,
    });
    expect(verifyViewToken(KEY, token({ expiresAt: NOW + 7 * DAY + 1 }), NOW)).toEqual({
      failure: "too_long",
    });
  });

  it("refuse signed claims that don't name an artifact", () => {
    expect(verifyViewToken(KEY, token({ artifactId: "../etc/passwd" }), NOW)).toEqual({
      failure: "malformed",
    });
  });
});

describe("viewLifetime", () => {
  it("is one hour by default, and 1 second to 7 days when asked", () => {
    expect(viewLifetime(undefined)).toBe(HOUR);
    expect(viewLifetime(DAY)).toBe(DAY);
    expect(viewLifetime(7 * DAY)).toBe(7 * DAY);
    for (const bad of [0, -1, 1.5, 7 * DAY + 1, Number.NaN]) {
      expect(() => viewLifetime(bad)).toThrow(ViewLinkLifetimeError);
    }
  });
});
