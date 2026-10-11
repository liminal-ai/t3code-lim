// Fork-only (lim): whether Claude's stored subscription login can actually sign in.
// The SDK's initialization result reports an account even when
// `.credentials.json` holds empty tokens (Nucbox, 2026-10-10: status said
// "authenticated" and only a real turn failed), so the status probe also reads
// the stored login. Env and proxy auth don't use that file.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * - `env`: an API key, auth token, base URL (a proxy such as cliproxy) or a
 *   cloud backend is set, so the stored login doesn't matter.
 * - `present`: a token that isn't expired, or a refresh token that isn't.
 * - `empty` / `expired`: the stored login can't sign in.
 * - `unknown`: no file (macOS keeps it in the Keychain), no Claude login in
 *   it, or it can't be read; the probe keeps its own answer.
 */
export type ClaudeStoredLogin = "env" | "present" | "empty" | "expired" | "unknown";

const ENV_AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;
/** Flags: only a true value turns a cloud backend on (`=0` or `=false` leaves it off). */
const ENV_AUTH_FLAGS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;
const flagOn = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

/**
 * Whether the active credential is the stored subscription login (`/login`),
 * the only case `.credentials.json` decides. An API key from any source
 * (`apiKeyHelper`, env, settings, a Console-managed key) outranks it, a
 * non-first-party backend doesn't use it, and on macOS the login is in the
 * Keychain, with the file only a fallback.
 */
export const usesStoredSubscriptionLogin = (input: {
  readonly apiProvider: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly platform: NodeJS.Platform;
}): boolean =>
  input.platform !== "darwin" &&
  (input.apiProvider === undefined || input.apiProvider === "firstParty") &&
  (input.apiKeySource === undefined || input.apiKeySource === "none");

export const claudeEnvAuth = (environment: NodeJS.ProcessEnv): boolean =>
  ENV_AUTH_KEYS.some((key) => (environment[key]?.trim() ?? "").length > 0) ||
  ENV_AUTH_FLAGS.some((key) => flagOn(environment[key]));

const token = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
/**
 * The access token's `expiresAt`: unset means none given, but a number, 0
 * included, is a time; Claude reads 0 as the epoch and reports "Login expired"
 * (anthropics/claude-code#83834).
 */
const accessUnexpired = (expiresAt: unknown, nowMs: number): boolean =>
  typeof expiresAt !== "number" || expiresAt > nowMs;
/** `refreshTokenExpiresAt` unset or 0 means none given. */
const refreshUnexpired = (expiresAt: unknown, nowMs: number): boolean =>
  typeof expiresAt !== "number" || expiresAt <= 0 || expiresAt > nowMs;

export function classifyClaudeCredentials(text: string, nowMs: number): ClaudeStoredLogin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const oauth =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      : undefined;
  if (oauth === null || typeof oauth !== "object") return "unknown";
  const login = oauth as Record<string, unknown>;
  if (token(login.accessToken) && accessUnexpired(login.expiresAt, nowMs)) return "present";
  if (token(login.refreshToken) && refreshUnexpired(login.refreshTokenExpiresAt, nowMs))
    return "present";
  return token(login.accessToken) || token(login.refreshToken) ? "expired" : "empty";
}

export const readClaudeStoredLogin = Effect.fn("readClaudeStoredLogin")(function* (
  configDir: string,
  environment: NodeJS.ProcessEnv,
  nowMs: number,
): Effect.fn.Return<ClaudeStoredLogin, never, FileSystem.FileSystem | Path.Path> {
  if (claudeEnvAuth(environment)) return "env";
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(configDir, ".credentials.json"))
    .pipe(Effect.orElseSucceed(() => null));
  return text === null ? "unknown" : classifyClaudeCredentials(text, nowMs);
});
