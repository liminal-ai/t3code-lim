// Fork-only (t3code-lim #21): a failed resume of a same-provider strong native
// ref never swaps in a fresh native session (Lee, 2026-10-08: never recreate a
// failed session). Transient failures go back to the worker's retry; anything
// else, or the last attempt, fails the run and leaves the binding as it was.
// See fork/README.md.
import type { OrchestrationV2ProviderThread, ProviderInstanceId } from "@t3tools/contracts";

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
 * True when the run must keep this provider thread's native session: the ref is
 * strong and belongs to the provider instance now running. A ref from another
 * provider (a provider switch) keeps upstream's portable fallback.
 */
export function keepsNativeBinding(
  providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef" | "providerInstanceId">,
  runProviderInstanceId: ProviderInstanceId,
): boolean {
  return (
    providerThread.nativeThreadRef?.strength === "strong" &&
    providerThread.providerInstanceId === runProviderInstanceId
  );
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
