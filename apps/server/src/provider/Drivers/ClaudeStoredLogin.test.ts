import { describe, expect, it } from "vite-plus/test";

import {
  claudeEnvAuth,
  classifyClaudeCredentials,
  settingsEnv,
  usesStoredSubscriptionLogin,
} from "./ClaudeStoredLogin.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const login = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });

describe("classifyClaudeCredentials", () => {
  it("calls the Nucbox file (both tokens empty, no expiry) empty", () => {
    // Shape from winnie/evidence/nucbox-2833-20261010/triage-readonly.json.
    const nucbox = login({
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      refreshTokenExpiresAt: 0,
      scopes: [],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    expect(classifyClaudeCredentials(nucbox, NOW)).toBe("empty");
  });

  it("accepts an unexpired access token, or an expired one with a live refresh token", () => {
    expect(
      classifyClaudeCredentials(login({ accessToken: "a", expiresAt: NOW + 60_000 }), NOW),
    ).toBe("present");
    expect(classifyClaudeCredentials(login({ accessToken: "a" }), NOW)).toBe("present");
    expect(
      classifyClaudeCredentials(
        login({ accessToken: "a", expiresAt: NOW - 1, refreshToken: "r" }),
        NOW,
      ),
    ).toBe("present");
  });

  it("reads an access token's expiresAt of 0 as the epoch, not as no expiry", () => {
    // anthropics/claude-code#83834: Claude reports "Login expired" for this file.
    expect(classifyClaudeCredentials(login({ accessToken: "a", expiresAt: 0 }), NOW)).toBe(
      "expired",
    );
    expect(
      classifyClaudeCredentials(
        login({ accessToken: "a", expiresAt: 0, refreshToken: "r", refreshTokenExpiresAt: 0 }),
        NOW,
      ),
    ).toBe("present");
  });

  it("calls tokens that have all run out expired", () => {
    expect(classifyClaudeCredentials(login({ accessToken: "a", expiresAt: NOW - 1 }), NOW)).toBe(
      "expired",
    );
    expect(
      classifyClaudeCredentials(
        login({
          accessToken: "a",
          expiresAt: NOW - 1,
          refreshToken: "r",
          refreshTokenExpiresAt: NOW - 1,
        }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("leaves a file it can't read, or one with no Claude login, to the probe", () => {
    expect(classifyClaudeCredentials("{not json", NOW)).toBe("unknown");
    expect(classifyClaudeCredentials(JSON.stringify({ mcpOAuth: {} }), NOW)).toBe("unknown");
  });
});

describe("claudeEnvAuth", () => {
  it("counts an API key, auth token, proxy base URL or cloud backend", () => {
    expect(claudeEnvAuth({})).toBe(false);
    expect(claudeEnvAuth({ ANTHROPIC_API_KEY: " " })).toBe(false);
    expect(claudeEnvAuth({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" })).toBe(true);
    expect(claudeEnvAuth({ ANTHROPIC_AUTH_TOKEN: "t" })).toBe(true);
    expect(claudeEnvAuth({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(claudeEnvAuth({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe(true);
  });

  it("leaves a cloud backend that's switched off to the stored login", () => {
    expect(claudeEnvAuth({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
    expect(claudeEnvAuth({ CLAUDE_CODE_USE_VERTEX: "false" })).toBe(false);
  });
});

describe("usesStoredSubscriptionLogin", () => {
  const login = { apiProvider: "firstParty", apiKeySource: "none", platform: "linux" as const };

  it("checks the file only for a first-party /login off macOS", () => {
    expect(usesStoredSubscriptionLogin(login)).toBe(true);
    expect(
      usesStoredSubscriptionLogin({ ...login, apiKeySource: undefined, apiProvider: undefined }),
    ).toBe(true);
    expect(usesStoredSubscriptionLogin({ ...login, platform: "win32" })).toBe(true);
  });

  it("leaves an active API key (apiKeyHelper, env, a managed key), another backend, or macOS alone", () => {
    expect(usesStoredSubscriptionLogin({ ...login, apiKeySource: "apiKeyHelper" })).toBe(false);
    expect(usesStoredSubscriptionLogin({ ...login, apiKeySource: "ANTHROPIC_API_KEY" })).toBe(
      false,
    );
    expect(usesStoredSubscriptionLogin({ ...login, apiKeySource: "/login managed key" })).toBe(
      false,
    );
    expect(usesStoredSubscriptionLogin({ ...login, apiProvider: "bedrock" })).toBe(false);
    expect(usesStoredSubscriptionLogin({ ...login, platform: "darwin" })).toBe(false);
  });
});

describe("settingsEnv", () => {
  it("reads a settings.json env block, so a proxy set there counts as env auth", () => {
    // Prod's claude-glm-lhc home sets its proxy this way.
    const env = settingsEnv(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", N: 1 } }),
    );
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
    expect(claudeEnvAuth(env)).toBe(true);
    expect(settingsEnv(JSON.stringify({ model: "x" }))).toEqual({});
    expect(settingsEnv("{not json")).toEqual({});
  });
});
