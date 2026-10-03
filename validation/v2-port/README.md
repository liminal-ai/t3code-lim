# Claude-LHC on T3 V2: port evidence (Hazel)

Branch `lhc-provider-v2` on the pin `8ed276c2` (v0.0.46-nightly.20261003.2610). Each step has its
failing tests committed on their own first.

| Step                                                                               | Before                                  | After                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Contracts: `claude-lhc` kind, `ClaudeLhcSettings`                                  | `contracts-tests-before.txt` (dbc215d2) | `contracts-tests-after.txt` (50048207): 500 pass                           |
| Sidecar seam + runner factory                                                      | `sidecar-tests-before.txt` (a0e40177)   | `sidecar-tests-after.txt` (a96485e7): 7 sidecar + 127 stock Claude adapter |
| LHC windows in the query settings                                                  | `lhc-options-tests-before.txt`          | `lhc-options-tests-after.txt` (390dee27)                                   |
| Driver (`makeClaudeDriver`, `ClaudeLhcDriver`, registration, compatibility policy) | `driver-tests-before.txt`               | `provider-tests-after.txt`: 1450 pass                                      |

`provider-tests-after.txt` has one failure that isn't from this port:
`AcpSessionRuntime.processTree.test.ts` expects `node` in `/usr/bin` or `/bin` (Node's default PATH);
on lim-builder node lives under fnm, so it fails here with or without these changes.
| Kind checks: `GitManager` (a Claude LHC writer reads `CLAUDE.md`), terminal (its Claude home) | `kind-checks-tests-before.txt`; the GitManager case corrected (the instance must be configured) and shown failing again without the fix: `kind-checks-gitmanager-without-fix.txt` | `kind-checks-tests-after.txt`: 202 pass |

`kind-checks-tests-after.txt` also has one GitManager timeout ("does not reuse a cross-repo PR when GitHub
omits head identity metadata"). It times out on the pin's own GitManager files too
(`gitmanager-crossrepo-timeout-on-stock.txt`), so it's environmental here, not from this port.
| Web: Claude LHC in Settings (own schema), model options, default model, traits, usage, readiness, icon; a Claude LHC draft never falls back to another kind | `web-tests-before.txt` | `web-tests-after.txt`: 5662 web unit tests pass |
| Live on the LHC lane (13977) | — | `live/README.md`: compaction, recall, restart, recovery, interrupt, fork refused, stock baseline |
