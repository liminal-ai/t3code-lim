# Maintaining T3 Code Lim

This repository preserves upstream T3 Code history and the deployed Claude-LHC patch. `origin` is `liminal-ai/t3code-lim`; `upstream` is `pingdotgg/t3code`.

## Differences

- Claude-LHC provider: pinned `claude-lhc@0.1.1`, compaction and durable recall, selectable beside normal Claude and Codex. The detailed implementation inventory is in [LHC-PATCH.md](../LHC-PATCH.md).
- Release packaging: bundles the LHC sidecar, Node runtime for standalone servers, and native runtime dependencies. Packaged Electron locates its bundled sidecar automatically. Desktop identity is `ai.liminal.t3code`, displayed as T3 Code Lim; update metadata targets this repository, never upstream.
- Fork release/CI workflows and this documentation. No comms code is embedded in T3: the external connector uses the orchestration API.

The LHC provider has the same existing limitations documented in LHC-PATCH.md. Model context choice remains configuration. Product changes should stay at the provider boundary; do not rewrite orchestration to accommodate the fork.

## Upstream updates

The exact baseline is recorded in [upstream.json](upstream.json). Preserve history and do not force-push shared `main`.

1. Fetch upstream tags: `git fetch upstream --tags`.
2. Create a worktree under `~/lim/wt/t3code-lim/<task>` with an update branch.
3. Merge the selected upstream release tag into that branch. Keep the existing small patch and resolve conflicts explicitly.
4. Update upstream.json and the README baseline. Review new upstream workflows before enabling any in this fork.
5. Open a PR into main. Run checks, build an untagged candidate and qualify staging with an independent tester before Lee reviews functional changes. Tag only after that review.

Upstream workflows remain in source to reduce merge churn, but are disabled in this repository's Actions settings. Only `lim-ci.yml` and `lim-release.yml` are enabled here. Upstream deployment workflows depend on upstream's secrets and infrastructure and must not be enabled here.

## Releases

Tag format: `<upstream-tag>-lim.<revision>`, for example `v0.0.46-nightly.20261003.2632-lim.2`. The tag is immutable; fixes get a new revision. upstream.json records the corresponding tag, commit and patch revision. Package versions are aligned during the build.

Before tagging, dispatch `lim-release.yml` against the candidate branch with `candidate=true`
and leave `tag` empty. It runs the same native builds and packaged server smoke tests,
uploads artifacts and checksums to the workflow run, and skips release publication.
Candidate versions include the workflow run ID and attempt. Record the commit, run and
artifact checksum used for staging. Back up staging config, data and data-lhc before
starting the candidate, since database migrations run on startup.

After independent testing and Lee's staging review, tag the reviewed commit with the
version in upstream.json. The tag workflow rebuilds with release version metadata;
these artifacts are not byte-identical to the candidate. Packaged smoke checks must
pass again on the tagged artifacts before publication and rollout.

The Liminal release workflow builds on native GitHub-hosted runners:

| Target        | Server/web | Electron |
| ------------- | ---------- | -------- |
| Linux x64     | tar.gz     | AppImage |
| macOS arm64   | tar.gz     | dmg      |
| Windows arm64 | zip        | NSIS exe |
| Windows x64   | zip        | NSIS exe |

Server archives include Node, the built web client, runtime dependencies, pinned LHC sidecar and release.json identifying the source. Extract and run `./t3 serve` (Windows: `t3.cmd serve`). Install/authenticate provider CLIs separately. Each archive is extracted and started in CI before publishing. All four jobs must pass before the release is published; SHA256SUMS covers its assets.

Initial desktop builds are unsigned (no signing credentials supplied). Windows desktop packages the native backend, not an embedded WSL backend. Private GitHub release downloads require authentication; do not embed a GitHub token in an application. Manual installer updates are the supported initial path.

## lim-builder installations

- Source: `~/lim/code/t3code-lim`; edits: `~/lim/wt/t3code-lim/<task>`.
- Production: `~/lim/service/t3code/prod`, port 13977, existing tailnet URL on 8460.
- Staging: `~/lim/service/t3code/staging`, port 13976, independent data and configuration.
- Each environment has `releases/<version>`, `current`, `config`, `data`, and `data-lhc` (the sidecar derives this sibling from the T3 home).

Service processes run extracted release artifacts, never the source checkout. Environment configuration records the provider executable PATH. Credentials are not stored in this repo. Production retains pairing, settings and threads. Staging starts with its own data; never copy live auth into it.

Before deployment, stop the specific service and back up its config, data and data-lhc together. Install the tested artifact, change current, start and smoke-check. Keep the previous release and backup. If a release migrates data incompatibly, restore its matching data backup during rollback; switching the executable alone is not a database rollback.

The desktop runtime name and locally hosted web title are **T3 Code Lim**, matching the installer. Legacy profile paths stay unchanged so upgrading preserves existing histories and pairings.
