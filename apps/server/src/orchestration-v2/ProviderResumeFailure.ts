// Fork-only (t3code-lim #21): T3 never replaces a strong native ref that has
// history, for any reason (Lee, 2026-10-08: never recreate a failed session;
// Mira #193). Transient failures go back to the worker's retry; anything else,
// or the last attempt, fails the run and leaves the binding as it was. Only
// reset-thread replaces such a ref. See fork/README.md.
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

/** Text of an error and its nested causes, for classifying provider failures. */
export function failureText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  const own = [record.message, record.errorMessage, record.code]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
  return `${own} ${failureText(record.cause, depth + 1)}`.trim();
}

// Failures that clear on their own: a racing `initialize` on a shared
// app-server (2026-10-08 prod incident), another writer still holding the
// native session (2026-10-07 Alder incident), or the provider process still
// starting or reconnecting.
const TRANSIENT =
  /already initialized|not initialized|already has an active writer|writer lock|resource busy|ebusy|econnrefused|econnreset|epipe|socket hang up|connection (closed|reset|refused)|transport closed|timed? ?out|starting up|temporarily unavailable/i;

/** True when a resume failure is worth retrying with the same native ref. */
export function isTransientResumeFailure(error: unknown): boolean {
  return TRANSIENT.test(failureText(error));
}

/**
 * True when a failed resume must keep this provider thread's native session:
 * the ref is strong. The fork-only invariant (fork/README.md, #21) holds for
 * every instance and switch; only reset-thread replaces such a ref.
 */
export function keepsNativeBinding(
  providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef">,
): boolean {
  return providerThread.nativeThreadRef?.strength === "strong";
}

export class NativeSessionResumeFailedError extends Error {
  override readonly name = "NativeSessionResumeFailedError";
  readonly threadId: string;
  readonly nativeId: string;
  // Not `cause`: the run's visible error uses a nested cause's message, and
  // this message is the one that names the thread and native session.
  readonly resumeFailure: unknown;
  constructor(threadId: string, nativeId: string, resumeFailure: unknown) {
    super(
      `Native session resume failed for thread ${threadId} (native ${nativeId}); the binding was kept: ${failureText(resumeFailure) || "unknown error"}`,
    );
    this.threadId = threadId;
    this.nativeId = nativeId;
    this.resumeFailure = resumeFailure;
  }
}
