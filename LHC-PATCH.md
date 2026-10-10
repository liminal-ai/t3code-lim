# LHC patch on T3 V2

Current upstream: `v0.0.46-nightly.20261006.2752`; exact source and patch revision are
in `fork/upstream.json`. The `claude-lhc` provider runs the stock Claude adapter
through the pinned npm `claude-lhc` sidecar for compaction and durable recall.
Compare the current fork with that upstream tag to inspect the carried patch.

The original port and its historical evidence are in `validation/v2-port/`.
Those records describe the old 2632 test installation, not current deployment paths.
Use [fork/README.md](fork/README.md) for packaged builds and installations.

## Files changed

Contracts

- `packages/contracts/src/claudeDriverKinds.ts` (+test), `index.ts`: the `claude-lhc` kind, `isClaudeDriverKind`.
- `packages/contracts/src/model.ts`: default models and display name for `claude-lhc`.
- `packages/contracts/src/settings.ts`: `ClaudeLhcSettings` (compact trigger 100k-1M, rebuilt view
  10k-1M and below the trigger). Test: `claudeLhcSettings.test.ts`.

Server

- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: only the seam (the rebase hot
  spot, +41/-11). `ClaudeQueryRuntime` / `ClaudeCreateQuery` types and
  `makeClaudeAgentSdkQueryRunner({createQuery, forkRefusal})`; the live runner layer is that with no
  options (the SDK's own `query`). Nothing else in the adapter changes.
- `apps/server/src/provider/Drivers/ClaudeLhcSidecar.ts` (+test): spawns the sidecar
  (`CLAUDE_LHC_SIDECAR`) over JSONL stdio. The runtime is its own iterator (V2 iterates the query
  object); `interrupt()` uses the sidecar's control. The store is always `<T3 home>-lhc`; the live
  stores `~/.t3code-lhc` (3773) and `~/.t3code-v044-lhc` (3780) are refused. The staged package must
  match `lhc/sidecar.json` (version and integrity). The seam adds the instance's two windows
  (`autoCompactWindow`, `lhcLowerBound`) to each query's settings, fitted to the query's model
  (`fitLhcCompactionToContextWindow`), so the adapter needs no LHC knowledge.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`: `makeClaudeDriver(spec)`; `ClaudeDriver` is the
  stock spec. The spec adds the instance's query runner, a fork refusal, an unavailable reason
  (reported as `installed: false`) and a continuation-key mapping. The stock `create` body keeps
  its indentation.
- `apps/server/src/provider/Drivers/ClaudeLhcDriver.ts` (+test): the LHC spec (fork refused: a fork
  copies the native transcript, not the LHC view).
- `apps/server/src/provider/builtInDrivers.ts`, `providerStatusCache.ts`: register and order the kind.
- `apps/server/src/provider/providerCompatibility.ts`: `claude-lhc` follows Claude's policy.
- `apps/server/src/git/GitManager.ts` (+test), `terminal/Manager.ts` (+test): `isClaudeDriverKind`.

Web

- `apps/web/src/components/settings/providerDriverMeta.ts` (+`providerDriverMeta.lhc.test.ts`):
  Claude LHC in Settings with `ClaudeLhcSettings`.
- `customModelEditor.logic.ts`, `ProviderModelsSection.tsx`: Claude's model options and default model.
- `usage/UsageLimits.tsx`, `onboarding/providerReadiness.logic.ts`:
  `isClaudeDriverKind`. `chat/ProviderInstanceIcon.tsx`: Claude's icon.
- `components/ChatView.logic.ts` (+test): a draft asking for Claude LHC never falls back to another
  kind; a vanished custom instance falls back to nothing.

Sidecar (`lhc/`)

- `sidecar.json` (pin: `claude-lhc@0.1.1` and integrity), `sidecar/package.json` +
  `sidecar/package-lock.json` (committed lock), `stage-sidecar.sh` (npm ci into `lhc/.sidecar`,
  checks the pin, prints the entry), `.gitignore`.

## Running it

Use the packaged server or desktop build described in [fork/README.md](fork/README.md).
Release builds stage the pinned sidecar with `node scripts/lim-stage-sidecar.mjs`.
Add a Claude LHC instance in Settings (or `server.updateSettings`,
`providerInstanceMutation: create`, driver `claude-lhc`). The sidecar stores its data
beside the T3 home in `<T3 home>-lhc`; keep both together when backing up or rolling back.

## Context window

T3's bundled model manifest gives Sonnet (4.6 and 5/5.5) a 200k context window by default, with 1M as
an option; Opus 5.5 and Fable default to 1M. A thread's `modelSelection` carries the choice
(`options: [{ id: "contextWindow", value: "1m" }]`), and the sidecar fits the compaction windows to
it. Settings can only set the new-thread default (`defaultModelSelection`, one instance, environment
or per project); threads created over the API (onboarding and test scripts, wherever agent threads are created) must pass the option themselves; the comms adapter only dispatches into existing threads, so it needs nothing. Defaults remain installation-specific configuration.

Models the catalog doesn't know (custom models such as GLM through cliproxy) take their window from
the custom model entry's optional `contextWindow`. An instance uses one window for all of them: the
smallest declared, with a bare entry counting as 200k, and 200k when none is declared. A model switch
reaches the running Claude Code through `setModel` without a respawn, so the window has to hold for
every model the thread can switch to. When an entry declares a window, the sidecar also passes it
to Claude Code as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, since Claude Code otherwise assumes 200k for a
non-Claude model name. Without `[1m]` it can't otherwise learn a larger window. (Mira #305, #308;
2026-10-10)

## Known limits

- New compaction windows apply when a session opens: V2 keeps a thread's query open across turns, so
  a change in Settings reaches a thread at its next session (a new thread, or after the session is
  released or the server restarts).
- Fork-then-switch (raise upstream; not fixed here, it needs a deeper change in the adapter). V2's
  Claude adapter labels every Claude instance's provider refs `claudeAgent`. Steps: (1) fork a
  Claude LHC thread; (2) before the child's first turn, switch the child's model to a stock Claude
  instance; (3) send. The child's first turn forks the LHC thread's native session through the stock
  runner, so the child starts from that native transcript (the first generation, before LHC's
  compactions), not the LHC view. An odd transcript, not data loss or a security issue. Forking
  without switching is refused ("Claude LHC threads can't be forked…").
- Two upstream tests fail on lim-builder with or without this patch (environment): an ACP test that
  expects `node` in `/usr/bin`, and a GitManager cross-repo PR test that times out.

## Size against the pin

Existing upstream files: 267 edited lines (+232/-35) in 18 files; the rest is new files (the
sidecar seam, the LHC driver, the kind module, tests, `lhc/`). Measured with
`git diff --numstat --diff-filter=M v0.0.46-nightly.20261006.2752 -- apps packages ':!*.test.ts'`.
