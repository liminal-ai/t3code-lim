import { ProviderDriverKind } from "./providerInstance.ts";

/** Stock Claude Agent SDK driver. */
export const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
/** Fork driver: the same runtime through the claude-lhc sidecar (long-horizon context). */
export const CLAUDE_LHC_DRIVER_KIND = ProviderDriverKind.make("claude-lhc");

export const CLAUDE_DRIVER_KINDS: ReadonlyArray<ProviderDriverKind> = [
  CLAUDE_DRIVER_KIND,
  CLAUDE_LHC_DRIVER_KIND,
];

/** True for every driver kind whose child process is Claude Code. */
export const isClaudeDriverKind = (kind: string | null | undefined): boolean =>
  kind === CLAUDE_DRIVER_KIND || kind === CLAUDE_LHC_DRIVER_KIND;
