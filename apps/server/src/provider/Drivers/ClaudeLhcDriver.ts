/**
 * ClaudeLhcDriver — the `claude-lhc` driver kind (LHC patch on stock T3).
 *
 * Same runtime, probe, capabilities cache and text generation as `ClaudeDriver`, built through
 * `makeClaudeDriver`; the difference is that every session's query runs inside the claude-lhc
 * sidecar (which records the thread into LHC and rebuilds context on compaction), that its
 * sessions can't be forked (a fork copies the native transcript, not the LHC view), and that its
 * continuation key never groups with a stock Claude instance on the same home.
 *
 * @module provider/Drivers/ClaudeLhcDriver
 */
import { CLAUDE_LHC_DRIVER_KIND, ClaudeLhcSettings } from "@t3tools/contracts";

import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { claudeLhcSidecarUnavailableReason, makeClaudeLhcCreateQuery } from "./ClaudeLhcSidecar.ts";

const STOCK_CONTINUATION_PREFIX = "claude:";

export const claudeLhcContinuationGroupKey = (stockKey: string): string =>
  stockKey.startsWith(STOCK_CONTINUATION_PREFIX)
    ? `claude-lhc:${stockKey.slice(STOCK_CONTINUATION_PREFIX.length)}`
    : `claude-lhc:${stockKey}`;

export const CLAUDE_LHC_FORK_REFUSAL =
  "Claude LHC threads can't be forked: a fork would copy the native transcript, not the LHC view. Start a new thread instead.";

export const ClaudeLhcDriver = makeClaudeDriver({
  driverKind: CLAUDE_LHC_DRIVER_KIND,
  displayName: "Claude LHC",
  configSchema: ClaudeLhcSettings,
  createQuery: ({ environment, baseDir, config }) =>
    makeClaudeLhcCreateQuery({
      environment,
      baseDir,
      windows: { autoCompactWindow: config.autoCompactWindow, lhcLowerBound: config.lhcLowerBound },
      customModels: config.customModels,
    }),
  forkRefusal: CLAUDE_LHC_FORK_REFUSAL,
  unavailableReason: claudeLhcSidecarUnavailableReason,
  continuationGroupKey: claudeLhcContinuationGroupKey,
});
