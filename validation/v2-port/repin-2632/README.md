# Claude-LHC re-pinned to v0.0.46-nightly.20261003.2632 (f391794a), LHC lane 13977, 2026-10-03

1. **Backup, the lane stopped:** `backups/lhc-20261003T145400Z` holds `bin/snapshot lhc`'s state and
   pin, plus the LHC store (`state-lhc/`), the runnable build the wrapper ran (`server-dist/`, from
   `build-commit.txt`), and the wrapper. `ROLLBACK-hazel.txt` there says how to restore all three.
   The pre-rebase branch is kept as `lhc-provider-v2-pre-2632`.
2. **Rebase** (not merge) of `lhc-provider-v2` from `8ed276c2` onto the tag: 20 commits, no conflicts,
   `pnpm-lock.yaml` unchanged. Upstream changed `ClaudeAdapterV2.ts` (+39/-10) without touching the seam.
3. **Checks** (`checks.txt`): contracts, server and web typecheck clean; contracts 500, server
   (provider, Claude adapter, terminal) 1560, web 5670 pass. One failure, upstream and environmental:
   the ACP test that expects `node` in `/usr/bin`.
4. **Rebuild** per the pin's build task, sidecar re-staged and checked against its pin; only the LHC
   service started. `providers.txt`: `claude-lhc` ready, Claude Code 2.1.288.
5. **Live checks** (`live-checks.mjs` → `live-checks.jsonl`, `sidecar-journal.txt`), fresh thread,
   instance windows 100k/40k:
   - recall after compaction, after restarting only the LHC service, after a mid-stream sidecar kill
     (the run ended `failed`; a new sidecar served the next turn): all pass;
   - manual `/compact`: pass; interrupt: `interrupted`, next turn answers; fork: the child's first turn
     fails with "Claude LHC threads can't be forked".
   - **Automatic compaction, first attempt failed** with "Prompt is too long": after two compacts the
     model read five fill files in one parallel batch, about 88k + 5 × 24k ≈ 208k. The cause was
     configuration: the test thread asked for `claude-sonnet-4-6` with no context-window option, and
     T3's model manifest defaults Sonnet to 200k. The thread recovered (manual compact, recall passed).
   - **The same fill on a 1M thread** (`fill-1m.mjs` → `fill-1m.jsonl`, `sidecar-journal-1m.txt`;
     parallel reads allowed): the sidecar started `claude-sonnet-4-6[1m]`; five compacts at 112-115k,
     no overflow; recall passed. (The journal's later `model=claude-sonnet-4-6` line is log-only: the
     id Claude Code reports back never carries the suffix.) The live checks' helper now asks for 1M.
   - **Settings:** the LHC lane's new-thread default is now Claude LHC, Sonnet 5.5, 1M
     (`../live/j-set-1m.mjs`, `../live/j-set-1m.txt`).
   - **Automatic compaction, reads one per batch** (`auto-compact-sequential.mjs` →
     `auto-compact-sequential.jsonl`, `sidecar-journal-seq.txt`): five compacts at 112-115k, each at a
     safe boundary; recall passed.
6. **Baseline** (`baseline-lhc-lane/`, `T3_TEST_LANE=lhc node bin/baseline.mjs`): all pass.

**Size against the new pin:** existing upstream files 267 edited lines (+232/-35), unchanged;
`ClaudeAdapterV2.ts` +41/-11 (seam only).
