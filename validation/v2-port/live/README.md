# Claude-LHC on T3 V2: live checks on the LHC lane (127.0.0.1:13977), 2026-10-03

The LHC lane runs this branch's build (`lhc-server-wrapper.sh` replaces `lhc/server`; the released
artifact it replaced is in `replaced-server-path.txt`; the lane was snapshotted first:
`backups/lhc-20261003T031336Z`). Stock (13976) was never touched. Claude Code 2.1.288 (the pinned
binary), sidecar claude-lhc 0.1.1 staged from the committed lock and checked against the pin.
Driven over the public API by `lib.mjs` (auth through the baseline's `rpc.mjs`, private cookie file).
Sidecar log lines (`sidecar-journal-*.txt`) are extracted from the lane's private log by the
`[claude-lhc:<pid>]` prefix only.

| Check                                        | Script / output                                                                   | Result                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance                                     | `create-instance.mjs`, `providers-2.txt`                                          | `claude-lhc` instance created through `server.updateSettings` (as Settings does); ready, installed, 2.1.288                                                     |
| First turn, store                            | `a-plant.mjs`, `a-plant.jsonl`, `sidecar-ps.txt`, `store-listing.txt`             | the turn ran through this branch's staged sidecar; the LHC store appeared at `lhc/state-lhc` (`registry.sqlite`, `threads/`), the T3 home plus `-lhc`           |
| Automatic compaction                         | `b-compact.mjs`, `b-compact.jsonl`, `sidecar-journal-b.txt`                       | three mid-turn compacts at 162k/163k/165k provider context, each at a safe boundary, compact point 17 → 32 → 47                                                 |
| Manual compaction                            | same                                                                              | `/compact` at 115k, compact point 50                                                                                                                            |
| Recall after compaction                      | `c-recall-restart.mjs`, `c-recall.jsonl`                                          | `amber lantern 3071`, planted before the first compact                                                                                                          |
| Recall after restarting only the LHC service | same                                                                              | `amber lantern 3071` (new sidecar, same store)                                                                                                                  |
| Sidecar killed while a run streams           | `e2-kill-midturn.mjs`, `e2-kill.jsonl`                                            | the run ended `failed` at the kill (no false completion); the next turn started a new sidecar and recalled the phrase                                           |
| Sidecar killed between turns                 | `e-recovery.mjs`, `e-recovery.jsonl`                                              | the next turn started a new sidecar and recalled the phrase                                                                                                     |
| Interrupt                                    | same                                                                              | the run ended `interrupted`; the next turn answered                                                                                                             |
| Fork refused                                 | `g-fork.mjs`, `g-fork.jsonl`                                                      | V2 creates the child thread at once; its first turn fails with "Claude LHC threads can't be forked: a fork would copy the native transcript, not the LHC view." |
| Stock paths on this build                    | `baseline-lhc-lane/results.json` (Alder's `bin/baseline.mjs`, `T3_TEST_LANE=lhc`) | native Claude and Codex turns, restart recall, native Claude fork with parent isolation, interrupt: all pass                                                    |

Notes

- The compaction ran at the fitted defaults (380k on Sonnet 4.6's 200k window → trigger 160k, view
  80k), not the lowered windows `b-compact.mjs` set: V2 keeps a thread's query process open across
  turns, so new windows apply when a session opens. The fit itself works live.
- `e-recovery.jsonl`'s first "kill mid-turn" hit the idle sidecar: Claude Code refused `sleep 45`
  and the run had already completed. `e2-kill-midturn.mjs` redoes it on a streaming run.
- Edge, not fixed: V2's Claude adapter labels provider refs `claudeAgent` for every Claude instance.
  A forked child that is switched to a stock Claude instance before its first turn would fork the LHC
  thread's native session through the stock runner (an old, pre-compaction transcript). Closing it
  needs the adapter to stamp the instance's driver kind.
