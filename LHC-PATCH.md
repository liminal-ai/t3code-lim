# LHC patch on T3 V2 (v0.0.46-nightly.20261003.2632)

Branch `lhc-provider-v2` on the pin `f391794a` (re-pinned from `8ed276c2`: `validation/v2-port/repin-2632/`). One addition: the `claude-lhc` provider driver, which
runs the stock Claude runtime through the npm `claude-lhc` sidecar (long-horizon context). Ported
from `lhc-provider` on v0.0.44 (`/srv/agents/hazel/t3code-v044`, its own `LHC-PATCH.md`). Review with
`git diff v0.0.46-nightly.20261003.2632 lhc-provider-v2`. Evidence: `validation/v2-port/` (each step's failing tests
first) and `validation/v2-port/live/` (the LHC lane on 13977).

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
- `chat/TraitsPicker.tsx`, `usage/UsageLimits.tsx`, `onboarding/providerReadiness.logic.ts`:
  `isClaudeDriverKind`. `chat/ProviderInstanceIcon.tsx`: Claude's icon.
- `components/ChatView.logic.ts` (+test): a draft asking for Claude LHC never falls back to another
  kind; a vanished custom instance falls back to nothing.

Sidecar (`lhc/`)

- `sidecar.json` (pin: `claude-lhc@0.1.1` and integrity), `sidecar/package.json` +
  `sidecar/package-lock.json` (committed lock), `stage-sidecar.sh` (npm ci into `lhc/.sidecar`,
  checks the pin, prints the entry), `.gitignore`.

## Running it (the LHC lane)

- Build per the pin's own task: `cd apps/server && vp run build` (web, then server: `dist/bin.mjs`,
  `dist/client`). Stage the sidecar: `lhc/stage-sidecar.sh`.
- `/srv/work/t3code-v2-baseline/lhc/server` is a wrapper (`validation/v2-port/live/lhc-server-wrapper.sh`)
  that sets `CLAUDE_LHC_SIDECAR` and runs `node dist/bin.mjs` with all arguments. Roll back by
  restoring the symlink in `backups/lhc-20261003T031336Z/server-path.txt`.
- Add the instance in Settings (or `server.updateSettings`, `providerInstanceMutation: create`,
  driver `claude-lhc`).

## Context window

T3's bundled model manifest gives Sonnet (4.6 and 5/5.5) a 200k context window by default, with 1M as
an option; Opus 5.5 and Fable default to 1M. A thread's `modelSelection` carries the choice
(`options: [{ id: "contextWindow", value: "1m" }]`), and the sidecar fits the compaction windows to
it. Settings can only set the new-thread default (`defaultModelSelection`, one instance, environment
or per project); threads created over the API must pass the option themselves. On the LHC lane the
default is Claude LHC, Sonnet 5.5, 1M.

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
`git diff --numstat --diff-filter=M v0.0.46-nightly.20261003.2632 -- apps packages ':!*.test.ts'`.
