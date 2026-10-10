# Maintaining T3 Code Lim

This repository preserves upstream T3 Code history and the deployed Claude-LHC patch. `origin` is `liminal-ai/t3code-lim`; `upstream` is `pingdotgg/t3code`.

## Differences

- Claude-LHC provider: pinned `claude-lhc@0.1.1`, compaction and durable recall, selectable beside normal Claude and Codex. The detailed implementation inventory is in [LHC-PATCH.md](../LHC-PATCH.md).
- Release packaging: bundles the LHC sidecar, Node runtime for standalone servers, and native runtime dependencies. Packaged Electron locates its bundled sidecar automatically. Desktop identity is `ai.liminal.t3code`, displayed as T3 Code Lim; update metadata targets this repository, never upstream.
- Fork release/CI workflows and this documentation.
- Agent comms: chat and administrative UI for agent comms can live in this fork. Comms server and connector code should generally stay outside T3; the connector reaches T3 through the orchestration API. (Source: Lee, 2026-10-07.) See [Agent comms UI](#agent-comms-ui).
- Native session resume fails closed (#21, #22). **Diverges from upstream.** A strong native ref is never replaced by a fresh session; a resume that fails fails the run and keeps the binding. Upstream's replacement-path tests are rewritten as fork-only. (Source: Lee, 2026-10-08 12:30 ET; Mira #156/#193/#200.) Note under [lim-builder installations](#lim-builder-installations).
- Re-importing a native session after its thread was deleted (#26). **Diverges from upstream.** Before writing a provider turn, the projection releases a row at the same provider-thread id and ordinal that belongs to a deleted thread. Fork-only; carry it through upstream updates until upstream scopes provider-thread ids by thread or cleans up turns on delete. (Source: Lee via Grok #7, 2026-10-09; Mira #238.) Note under [lim-builder installations](#lim-builder-installations); test in `ProjectionStore.test.ts` ("re-imported").
- Compact-before-send is opt-in (2026-10-10). **Diverges from upstream.** Upstream's Compact chip on a stale Claude thread starts armed and re-arms after each send; here it starts at "Full", the person arms it for one message, and the send disarms it, so a plain Send or Enter never compacts first. Rule and tests: `resolveCompactBeforeSend` in `ContextWindowMeter.logic.ts`. (Source: Lee via Alder #105 and Mira #281; upstream #17467.)
- Group-chat delete (#28). "Delete group…" in the chat header and bulk delete on Comms > Groups, through `conversations:deleteConversation` (agent-comms #30). (Source: Lee via Mira #254/#258/#262.)
- Sidebar Agents block (#27). Pinned threads are a collapsible "Agents" section of compact one-line rows sorted by activity. (Source: Lee, 2026-10-08/09.) Note under [lim-builder installations](#lim-builder-installations).
- Persistent artifacts, PR 1: store and list API. Files kept across threads in a git-versioned store at `<baseDir>/artifacts`, with list item ops, thread links and a change stream at `/api/artifacts/*`. No UI or agent tools yet. Fork-only: `apps/server/src/artifacts/`, `packages/contracts/src/limArtifacts.ts`; seams marked `// Fork seam (artifacts)` in `server.ts` and contracts `index.ts`. No statev2 change. (Source: Lee, 2026-10-10; spec r4 approved by Mira.) See [Artifacts](#artifacts).

The LHC provider has the same existing limitations documented in LHC-PATCH.md. Model context choice remains configuration. LHC changes should stay at the provider boundary; do not rewrite orchestration to accommodate the LHC patch. Fork UI features such as views, settings and sidebar sections are in scope (source: Lee, 2026-10-07). Where practical, keep them in their own files so upstream merges stay cheap.

## Agent comms UI

Chat and admin UI for the agent comms server (source: Lee, 2026-10-07: chat and administrative UI may live in this fork; comms server and connector code should generally stay outside T3). Everything fork-only is in `apps/server/src/comms/` and `apps/web/src/comms/`, plus the page route `apps/web/src/routes/_chat.group-chats.$conversationId.tsx`.

- **Server proxy** (`CommsProxy.ts`, registered in `server.ts`): `GET /api/comms/config`, `POST /api/comms/call`, `POST /api/comms/watch` (NDJSON live queries over Convex subscriptions). The browser authenticates with its T3 session (read scope for queries, operate for mutations); the server adds the comms admin token, read per request from a file. No browser holds the token. Only the admin functions listed in `commsPolicy.ts` are reachable; never `connector:*`.
- **Configuration** (environment; without the first two the routes answer 404 and the UI hides): `COMMS_CONVEX_URL`, `COMMS_ADMIN_TOKEN_FILE`, `COMMS_POST_AS` (the person the UI posts as), `COMMS_HOME_MACHINE` (the comms machine whose connector drives this T3), `COMMS_TEST_MODE=1`.
- **Test mode** (test naming, source: Lee, 2026-10-07: test agents `ta-`, test groups `tg-`): only `ta-` agents owned by the post-as person and homed on the test machine, only `tg-` groups whose members are `ta-` agents or the post-as person, posts only as that person; reminders and alerts are refused; lists show only test conversations.
- **Which server** (`commsRoute.logic.ts`, `useCommsEnvironmentRouting.ts`): the UI talks to whichever connected T3 serves comms. Candidates, in order: the active environment, the primary (local) server, then other connected environments. The first whose `/api/comms/config` reports enabled wins, so a desktop connected to a remote T3 (staging, lim-builder) gets comms from it, with or without its own local server. A remote is called with its own base URL and the bearer from its paired connection; DPoP (relay) environments, and cookie sessions on another origin, are skipped. Switching to another comms server drops what the old one showed and re-watches.
- **Sidebar**: a Group Chats shelf above Settled (`GroupChatsShelf.tsx`), mounted at three `// Fork seam (agent comms)` sites in upstream `Sidebar.tsx`; with no threads (the empty state replaces the list) it shows at the bottom on its own. After an upstream sync touching `Sidebar.tsx`, grep for that marker and smoke-check that the shelf still renders above Settled and on an empty sidebar (the marker alone does not prove placement).
- **Comms page** (`/comms`, the Comms button in the sidebar's bottom row; `CommsPage.tsx`, `CommsDialogs.tsx`): Agents (live roster with presence, homes and owners; register an agent from one of this server's T3 threads ("This T3") or on any machine registered with comms ("Another machine": machine picked from the comms machine list, harness from the known list plus any in use, with per-harness locator help); pause, resume, retire; edit profile; open an agent's thread when it's homed on `COMMS_HOME_MACHINE`) and Group Chats (list, create, manage members). Mounted at `// Fork seam (agent comms)` sites in `SidebarChrome.tsx` and `mainAppLocation.ts`.
- **Chat page**: transcript with per-recipient delivery state, a working row per agent still on a delivery, and failure reasons on hover, answers linked to the request they answer, a Members button, and a composer with one checkbox per member (who to wake, remembered per chat), @mention autocomplete and a wake preview. The comms server wakes only the recipients a post names.

## Artifacts

Files Lee and agents keep across threads (spec: `~/lim/agents/artifacts/PROPOSAL.md`, r4). PR 1 is the store and its HTTP API; agent tools and the `/artifacts` page come in later PRs.

- **Store** (`apps/server/src/artifacts/`): `<baseDir>/artifacts`, next to `userdata/` (a dev server uses `<baseDir>/dev/artifacts`; `T3_ARTIFACTS_DIR` overrides both, for tests and QA only). Plain markdown files with YAML front matter (`id`, `title`, `tags`), a git repository with one commit per change (author: Lee or the agent; trailers record each event), and an index at `.t3/index.sqlite` (its own `node:sqlite` file, git-ignored, never statev2). `.t3-meta/links.json` holds thread links and is written in the same commit as every attach and detach.
- **Rebuildable index**: delete `.t3/index.sqlite` and restart, and the store rebuilds artifacts and tags from the files, links from `.t3-meta/links.json`, and events from the commit log. A schema change rebuilds instead of migrating.
- **No watcher**: a startup scan plus a size/mtime check on every read and write. Edits made outside T3 are committed as "External edit" before anything is served or applied; new markdown files are adopted (given an id); moves and removals are followed.
- **Lists**: each top-level `- [ ]`/`- [x]` line is an item with a trailing `^id`. Ops (`add`, `edit`, `check`, `uncheck`, `move`, `remove`) apply to the current file, all or none, one writer at a time; an op on a missing item fails with `item_not_found` and the current revision.
- **API** (`ArtifactHttp.ts`): `GET/POST /api/artifacts`, `GET /api/artifacts/:id`, `POST …/:id/ops`, `POST …/:id/links`, `DELETE …/:id/links/:threadId`, `POST /api/artifacts/watch` (NDJSON). Session auth as on the comms routes: `orchestration:read` for reads, `orchestration:operate` for writes (not `filesystem:read`, so every paired device works). Responses name the environment and store path. Paths are confined to the store. If the store can't open (for example no `git`), the routes answer 503 and the rest of T3 is unaffected.
- **Backup**: the store is inside `data/`, so the prod deploy's cold backup and `restore_backup` include it.

## Upstream updates

The exact baseline is recorded in [upstream.json](upstream.json). Preserve history and do not force-push shared `main`.

1. Fetch upstream tags: `git fetch upstream --tags`.
2. Create a worktree under `~/lim/wt/t3code-lim/<task>` with an update branch.
3. Merge the selected upstream release tag into that branch. Keep every patch listed under [Differences](#differences), resolve conflicts explicitly, and run each patch's tests. (Source for listing every T3 patch there: Lee via Grok #7, 2026-10-09.)
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
- The artifact store is `data/artifacts`; the deploy backup and restore include it. See [Artifacts](#artifacts).

Service processes run extracted release artifacts, never the source checkout. Environment configuration records the provider executable PATH. Credentials are not stored in this repo. Production retains pairing, settings and threads. Staging starts with its own data; never copy live auth into it.

Before deployment, stop the specific service and back up its config, data and data-lhc together. Install the tested artifact, change current, start and smoke-check. Keep the previous release and backup. If a release migrates data incompatibly, restore its matching data backup during rollback; switching the executable alone is not a database rollback.

The desktop runtime name and locally hosted web title are **T3 Code Lim**, matching the installer. Legacy profile paths stay unchanged so upgrading preserves existing histories and pairings.

**Prod deploy (`fork/ops/prod-deploy-t3.sh`, runbook on #12).** Runs the install in its own transient unit, takes a verified cold backup, and bounds every health-check request (2026-10-08: an unbounded `curl` failed a healthy start). **No automated rollback** (Lee, 2026-10-08, via Mira; Quinn's TESTING_STANDARDS T-8): any failure after the first state change stops and changes nothing further (no restore, no `current` repoint, no service or connector restart), writes `FAILED` plus the exact rollback command to the receipt, alerts on #12 and over comms, and names the shepherd (Tux). The shepherd runs `rollback`, or accepts with `resume-deliveries --decision`. After deliveries resume, `verify-identity` compares every provider row's native ref with the pre-deploy snapshot and searches the journal for fresh-session fallbacks (T-9). Deliveries stay paused until `resume-deliveries`. Every command after `launch` refuses, changing nothing, when this shell's target (unit, prod dir, connector, port) differs from the receipt's. It also refuses when a newer receipt supersedes this one (a deploy that failed before changing anything doesn't count) and when another operation holds the per-prod lock. `launch` also refuses while the newest deploy is still open, i.e. its deliveries haven't resumed. The shepherd closes a deploy recovered by hand with `close-receipt <dir> --decision <ref>`. Receipts written before #22 record no target, so the other commands refuse them; recover those by hand. The only one, `20261008T1125121677Z` (ROLLBACK FAILED, recovered by hand that morning), needs `close-receipt` before the next prod launch. `fork/ops/prod-deploy-test.sh` runs it against fake prods (own units and ports) on lim-builder.

**Native session resume (#21). Diverges from upstream.** The invariant (2026-10-08; Lee at 12:30 ET: fail loudly instead of starting a fresh native session, plus an explicit reset-thread; Mira #193 and #200, which supersede #156 and #178's exemptions): **T3 never replaces a strong native ref, for any reason**: account overlay, in-place or queued switch, import, copied ref, a return to a provider, or an uncertain history delivery (an imported session has native history T3 never recorded, so "no turns" can't prove nothing is lost). Only reset-thread replaces one, on an explicit decision. When resuming such a ref fails, transient failures (a racing `initialize`, another writer still holding the session, connection or startup errors, timeouts) go back to the worker's retry with the same ref. Definitive or unknown failures, and the last attempt, fail the run with "Native session resume failed", naming the thread and native id at error level, and keep the ref for triage and reset-thread. Upstream's fresh-session fallback remains only for weak or missing refs (a first run on a provider with no ref for that driver still gets a fresh session). Provider switches and native history are deliberately not inferred. **Upstream merges:** upstream's "uses portable fallback when native resume fails after a provider switch" test in `testkit/ProviderSwitch.integration.test.ts` is now the fork-only "keeps the native session and fails the run when resume fails after a provider switch", and the injection case of upstream's "recovers %s failure without duplicating history" now fails the retry and keeps the native thread (test renamed "handles a %s failure without duplicating history or replacing the native thread"). Upstream's other replacement-path tests there bind weak refs when resume is set to fail (`strongRefOnResumeFailure` keeps strong), and the upstream fallback unit test uses a weak ref. Fork-only: `ProviderResumeFailure.ts`, the resume block in `ProviderTurnStartService.ts`, those test changes, and the seven-case invariant test in `ProviderTurnStartService.test.ts`.

**Re-importing a native session after its thread was deleted (#26, 2026-10-09, Winnie). Diverges from upstream.** Provider-thread ids derive from driver, instance and native id only, so importing a native session again into a new thread reuses the provider-thread id of the earlier thread. A deleted thread's provider turns stay in the projection, and their `(provider_thread_id, ordinal)` keys made the new thread's first turn fail with `UNIQUE constraint failed` ("provider event ingestion failed"). Writing a provider turn now first removes a row at the same key that belongs to a **deleted** thread; a live thread's row still conflicts. The events stay in the store. Fork-only: the `provider-turn.updated` case in `ProjectionStore.ts` and its test.

**Agents block in the sidebar (Lee, 2026-10-08/09).** Pinned threads are a collapsible "Agents" section (open by default; `t3code-lim:sidebar:agents-expanded` in local storage). They render as compact one-line rows using upstream's `slim` row: project icon, title, provider glyph, and live status (Working, Needs input, Failed and so on) or age on the right; the pin (unpin) appears on hover. Unlike settled rows they don't dim. They sort by most recent activity (latest user message or run request, start or completion; `updatedAt` only when there's none), so drag-reordering within pinned is off; dragging a thread in to pin or out to unpin still works. Unpinned threads keep upstream's full cards. Fork-only: `Sidebar.tsx` (row variant choice, pinned branch of the slim row, Agents header and collapse), `sortPinnedThreadsByActivity` in `Sidebar.logic.ts` and its test.

**Testing a candidate beside an installed app.** Set `T3CODE_DESKTOP_USER_DATA_DIR` to an absolute path for a dedicated Electron profile directory (a relative path resolves against the launch directory) and `T3CODE_HOME` to a dedicated state directory; the app refuses to start with the first and not the second, which would run on the default T3 home's live threads and pairings. Create the profile directory first. The packaged app then uses that profile instead of `<appData>/t3code-v2`, never inspects or copies from the default profiles, and skips the V1 Local Storage import. Chromium's `--user-data-dir` is not honored, because the app sets its profile path itself. Not isolated: the macOS keychain item "T3 Code Safe Storage", `t3code://` scheme registration, and Windows credential keys. Example (macOS): `T3CODE_DESKTOP_USER_DATA_DIR=/tmp/t3-cand/profile T3CODE_HOME=/tmp/t3-cand/home "T3 Code Lim.app/Contents/MacOS/<binary>"`. Fork-only: `DesktopConfig.ts`, `DesktopEnvironment.ts`, `DesktopUserData.ts`, `DesktopLegacyLocalStorage.ts` (#18).
