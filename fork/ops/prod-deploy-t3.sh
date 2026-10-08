#!/usr/bin/env bash
# Prod T3 (t3code-lim-prod) install of a t3code-lim candidate, run as its own systemd
# unit so it survives the prod restart (agent shells live in prod's cgroup).
# Author: @jess. Review: @alder (2632 -> 2752 rollout), @kit (COMMS_* values).
# NOT approved to run against prod until Lee OKs it through @mira.
#
#   prod-deploy-t3.sh plan                        read-only: resolve paths, check hashes, print the plan
#   prod-deploy-t3.sh launch --approved "<ref>" --heads-up-sent [--apply-comms]
#                                                 start `run` in its own transient unit, then exit
#   prod-deploy-t3.sh resume-deliveries <receipt-dir> --checks-done "<who/link>"
#                                                 start the connector once the manual checks pass
#   prod-deploy-t3.sh rollback <receipt-dir>      restore the old release AND its data together, run
#                                                 (like launch) in its own transient unit; the shepherd's step
#   prod-deploy-t3.sh verify-identity <receipt-dir>
#                                                 after deliveries resume: native refs vs the pre-deploy snapshot
#
# No automated rollback (Lee, 2026-10-08, via @mira #153/#154; Quinn's TESTING_STANDARDS T-8):
# any failure after the first state change stops, changes nothing further (no restore, no
# `current` repoint, no service or connector restart), leaves deliveries paused, writes FAILED
# plus the exact rollback command to the receipt, alerts and names the shepherd (Tux). Rolling
# back is the explicit `rollback` command the shepherd runs. Deliveries stay paused after every
# outcome except a failure before anything changed; only `resume-deliveries` releases them.
# `verify-identity` compares every provider row's native ref with the pre-deploy snapshot (T-9). Every step appends to
# <receipt-dir>/receipt.log and updates receipt.json. Credentials are never printed: env
# files are copied privately (mode 600), only key names are logged.
#
# The settings below can be overridden from the environment for the isolated failure tests
# (fork/ops/prod-deploy-test.sh, a fake prod). JESS_DEPLOY_FAULT is refused against real prod.
set -euo pipefail
umask 077

REAL_PROD=$HOME/lim/service/t3code/prod
# --- what this deploy installs (candidate 37764561844, commit 45f38d607c: #10 #13 #14 #17 #19; Lee OK via Mira #116) ---
CANDIDATE_RUN=${CANDIDATE_RUN:-37764561844}
EXPECTED_COMMIT=${EXPECTED_COMMIT:-45f38d607cbba9e4fae2c2fd0a8ddb57a953d4f7}
RELEASE_NAME=${RELEASE_NAME:-t3code-lim-0.0.46-nightly.20261006.2752-lim.1.candidate.${CANDIDATE_RUN}.1-linux-x64}
ARTIFACT=${ARTIFACT:-$HOME/lim/agents/jess/notes/staging-rollout-pr4/artifact-${CANDIDATE_RUN}/${RELEASE_NAME}.tar.gz}
EXPECTED_SHA256=${EXPECTED_SHA256:-b51a55c956acd5cd5ed83b3355bb5ca7d10df2f5d333741297d380a82a14410f}
# The candidate's migrations; prod is at 56 (2026-10-08), staging at 58 on this line.
EXPECTED_NEW_MIGRATIONS=${EXPECTED_NEW_MIGRATIONS:-"57 58"}

# --- prod layout (checked against the unit in preflight) ---
UNIT=${UNIT:-t3code-lim-prod}
PROD=${PROD:-$REAL_PROD}
PORT=${PORT:-13977}
CONNECTOR_UNIT=${CONNECTOR_UNIT:-comms-prod-connector}
BACKUPS=${BACKUPS:-$HOME/lim/service/t3code/prod-backups}
RECEIPTS=${RECEIPTS:-$HOME/lim/agents/jess/notes/prod-deploy}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
ATTACH_TIMEOUT=${ATTACH_TIMEOUT:-60} # connector must report attaching to prod T3 within this after resume
# Where a stop is announced ("none" disables; the isolated tests use none).
ALERT_ISSUE=${ALERT_ISSUE:-liminal-ai/t3code-lim#12}
ALERT_TO=${ALERT_TO:-tux mira}
SHEPHERD=${SHEPHERD:-tux}
OVERRIDABLE=(CANDIDATE_RUN EXPECTED_COMMIT RELEASE_NAME ARTIFACT EXPECTED_SHA256 EXPECTED_NEW_MIGRATIONS
  UNIT PROD PORT CONNECTOR_UNIT BACKUPS RECEIPTS HEALTH_TIMEOUT ATTACH_TIMEOUT ALERT_ISSUE ALERT_TO SHEPHERD)
FAULT=${JESS_DEPLOY_FAULT:-}
if [[ -n "$FAULT" && "$PROD" == "$REAL_PROD" ]]; then echo "fault injection is refused against real prod" >&2; exit 2; fi
# The isolated tests stand in an unreadable journal for verify-identity; real prod always reads journalctl.
JOURNALCTL=${JOURNALCTL:-journalctl}
if [[ "$JOURNALCTL" != journalctl && "$PROD" == "$REAL_PROD" ]]; then echo "JOURNALCTL override is refused against real prod" >&2; exit 2; fi

# --- COMMS_* for prod (values from @kit, 2026-10-08); applied only with --apply-comms ---
COMMS_LINES=(
  "COMMS_CONVEX_URL=https://merry-octopus-486.convex.cloud"
  "COMMS_ADMIN_TOKEN_FILE=$HOME/lim/service/comms/prod/config/admin-token"
  "COMMS_POST_AS=lee"
  "COMMS_HOME_MACHINE=lim-builder"
)

T3() { "$PROD/current/t3" "$@"; }
session_ids() { # sorted session ids only; connected/lastConnectedAt change on reconnect
  T3 auth session list --base-dir "$PROD/data" --json | python3 -I -c 'import json,sys;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("sessions",d);print("\n".join(sorted(x["sessionId"] for x in d)))'
}
migrations() { # applied migration ids, ascending, space-separated (read-only)
  python3 -I - "$PROD/data/userdata/statev2.sqlite" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(" ".join(str(r[0]) for r in c.execute("select migration_id from effect_sql_migrations order by 1")))
EOF
}
migration_names() { # "<id> <name>" for the given ids
  python3 -I - "$PROD/data/userdata/statev2.sqlite" "$@" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
ids = [int(x) for x in sys.argv[2:]]
print(", ".join(f"{i} {n}" for i, n in c.execute(
    f"select migration_id, name from effect_sql_migrations where migration_id in ({','.join('?'*len(ids))}) order by 1", ids)))
EOF
}
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$RECEIPT/receipt.log"; }
state() { # state <key> <value>: record a fact in receipt.json
  python3 -I - "$RECEIPT/receipt.json" "$1" "$2" <<'EOF'
import json, os, sys
p, k, v = sys.argv[1:]
d = json.load(open(p)) if os.path.exists(p) else {}
d[k] = v
json.dump(d, open(p, "w"), indent=1)
EOF
}
native_refs() { # {provider_thread_id: [thread_id, nativeId, strength]} for every provider row (read-only)
  python3 -I - "$PROD/data/userdata/statev2.sqlite" <<'EOF2'
import json, sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
out = {}
for pt, t, payload in c.execute("select provider_thread_id, thread_id, payload_json from orchestration_v2_projection_provider_threads"):
    ref = (json.loads(payload or "{}").get("nativeThreadRef") or {})
    out[pt] = [t, ref.get("nativeId"), ref.get("strength")]
print(json.dumps(out, sort_keys=True))
EOF2
}
receipt_get() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$RECEIPT/receipt.json" "$1"; }
target_id() { echo "unit=$UNIT prod=$PROD connector=$CONNECTOR_UNIT port=$PORT"; }
check_target() { # check_target <command>: refuse unless this shell targets what the receipt's deploy targeted
  # A fresh shell defaults to real prod; a sandbox receipt must never drive it (Macroscope, #22).
  # Receipts from before 2026-10-08's #22 record no target and are refused; recover those by hand.
  local want; want=$(receipt_get target)
  [[ -n "$want" ]] || { echo "refusing $1: receipt records no target (written before #22); nothing changed" >&2; return 1; }
  [[ "$want" == "$(target_id)" ]] || { echo "refusing $1: receipt targets '$want', this shell targets '$(target_id)'; nothing changed" >&2; return 1; }
}
check_latest() { # check_latest <command>: refuse an older receipt once a newer deploy exists (Macroscope, #22)
  # Only timestamp-named receipts count (not an archive/ or notes/ folder), and not a receipt whose deploy
  # failed before changing anything (preflight, including losing the lock): it can't supersede an
  # installed one (Macroscope, Codex, Quinn on #22).
  local d newest=""
  while IFS= read -r d; do
    [[ "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("result",""))' "$RECEIPTS/$d/receipt.json" 2>/dev/null)" == "failed before any change"* ]] && continue
    newest=$d
  done < <(find "$RECEIPTS" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*Z' -printf '%f\n' | sort)
  [[ "$newest" == "$(basename "$RECEIPT")" ]] || { echo "refusing $1: a newer deploy receipt exists ($RECEIPTS/$newest); nothing changed" >&2; return 1; }
}
previous_open() { # previous_open [own-ts]: why the newest other deploy receipt is still open; 1 if closed or none
  # A deploy is closed once deliveries resumed, or the shepherd closed it with close-receipt after a manual
  # recovery. Until then a new launch would back up and build on the half-decided state (Quinn, #22).
  local d r
  d=$(find "$RECEIPTS" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*Z' ! -name "${1:-none}" -printf '%f\n' 2>/dev/null | sort | while IFS= read -r x; do
    [[ "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("result",""))' "$RECEIPTS/$x/receipt.json" 2>/dev/null)" == "failed before any change"* ]] || echo "$x"; done | tail -1)
  [[ -n "$d" ]] || return 1
  # Closed only on an explicit CLOSED; anything else, python3 failing included, reads as open (Quinn, #22).
  r=$(python3 -I -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("receipt.json missing or unreadable"); sys.exit(0)
if d.get("closed") or str(d.get("deliveries","")).startswith("resumed"): print("CLOSED"); sys.exit(0)
print("result: %s; deliveries: %s" % (d.get("result","(still running)")[:120], d.get("deliveries","-")))' "$RECEIPTS/$d/receipt.json" 2>/dev/null) || r="receipt could not be read"
  [[ "$r" == CLOSED ]] && return 1
  echo "previous deploy $RECEIPTS/$d is still open ($r); finish its next step, or close it with close-receipt after a manual recovery"
}
take_lock() { # take_lock <command>: one state-changing operation per prod at a time; never waits (Macroscope, Codex, #22)
  exec 9>>"$PROD/.prod-deploy.lock"
  flock -n 9 || { echo "refusing $1: another deploy, rollback, restart or resume holds $PROD/.prod-deploy.lock; nothing changed" >&2; return 1; }
}
# Every request is bounded: on 2026-10-08 an unbounded curl that connected while T3 was starting
# never returned, so the 180 s wait failed against servers that were up (receipt 20261008T1125121677Z).
http_code() { curl -s -o /dev/null --connect-timeout 2 --max-time 5 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true; }
wait_http() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) code=""
  while ((SECONDS < deadline)); do
    code=$(http_code)
    [[ "$code" == 200 ]] && return 0
    sleep 2
  done
  log "health check: no HTTP 200 within ${HEALTH_TIMEOUT}s (last code: ${code:-none})"
  return 1
}
svc_stop() { # stop a unit and confirm it is no longer active
  systemctl --user stop "$1" || return 1
  [[ "$(systemctl --user is-active "$1" || true)" != active ]]
}

# --- outcomes: every exit goes through finish(); anything else is caught by on_exit ---
PHASE=preflight FINISHED=0 LAST_CMD=""
finish() { # finish <result> <exit code>
  FINISHED=1; state result "$1"; log "RESULT: $1"; exit "$2"
}
on_exit() {
  local code=$1
  ((FINISHED)) && return
  ((code == 0)) && return
  handle_failure "unexpected error ($LAST_CMD, exit $code)"
}
handle_failure() { # never returns
  set +e; trap - EXIT ERR
  log "FAILED in phase $PHASE: $1"
  case $PHASE in
    preflight) finish "failed before any change: $1" 1 ;;
    stopped | installed) hold_for_decision "$1" ;;
  esac
  finish "failed: $1" 1
}
restore_backup() { # the old release and its pre-migration data, together; 0 only if prod is healthy after
  local backup=$1 aside d
  [[ -n "$backup" && -f "$backup" ]] || { log "no verified backup recorded; NOT restoring"; return 1; }
  sha256sum -c --quiet "$backup.sha256" || { log "backup checksum mismatch; NOT restoring"; return 1; }
  if [[ "$FAULT" == restore_stop_fails ]] || ! svc_stop "$UNIT"; then
    [[ "$FAULT" == restore_stop_fails ]] && log "injected fault: stop before restore fails"
    log "could not confirm $UNIT stopped; NOT moving data while it may be running"; return 1
  fi
  aside=$PROD/failed-$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$aside" || { log "could not create $aside"; return 1; }
  for d in config data data-lhc current; do
    mv "$PROD/$d" "$aside/$d" || { log "moving $d aside failed; partial state in $aside"; return 1; }
  done
  tar -C "$PROD" -xzf "$backup" || { log "extracting the backup failed; prod dirs incomplete; failed state in $aside"; return 1; }
  log "restored config, data, data-lhc and current from $backup (failed state kept in $aside)"
  [[ "$(readlink "$PROD/current")" == "$OLD_RELEASE" ]] || { log "restored link is not $OLD_RELEASE"; return 1; }
  [[ "$(migrations)" == "$MIG_BEFORE" ]] || { log "restored migrations are not the pre-deploy set"; return 1; }
  systemctl --user start "$UNIT" || { log "$UNIT did not start after restore"; return 1; }
  wait_http || { log "prod did not answer HTTP 200 within ${HEALTH_TIMEOUT}s after restore"; return 1; }
  log "prod back up on $OLD_RELEASE with migrations up to ${MIG_BEFORE##* }"
}
alert() { # alert <text>: receipt file always; issue comment and comms DM best-effort
  local text="prod-deploy-t3.sh ($RECEIPT): $1"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$text" >> "$RECEIPT/ALERT.txt"
  if [[ "$ALERT_ISSUE" != none ]]; then
    timeout 60 gh issue comment "${ALERT_ISSUE#*#}" --repo "${ALERT_ISSUE%#*}" --body "**Deploy stopped for a decision.** $text" >/dev/null 2>&1 \
      && log "alert posted on $ALERT_ISSUE" || log "alert: posting on $ALERT_ISSUE failed"
  fi
  local who
  [[ "$ALERT_TO" == none ]] || for who in $ALERT_TO; do
    timeout 30 comms send --as jess --continue "@$who" "$text" >/dev/null 2>&1 \
      && log "alert sent to @$who" || log "alert: comms to @$who failed (connector may be stopped)"
  done
}
hold_for_decision() { # a check failed after the first change: stop here, change nothing, hand off
  local unit_state conn_state cmd
  unit_state=$(systemctl --user is-active "$UNIT" || true)
  conn_state=$(systemctl --user is-active "$CONNECTOR_UNIT" || true)
  # Nothing installed yet (phase stopped): there is nothing to roll back, only the unchanged
  # old release to restart, which is the shepherd's call (Quinn's review of #22, D1).
  if [[ "$PHASE" == stopped ]]; then cmd="$(readlink -f "$0") restart-unchanged $RECEIPT"; else cmd="$(readlink -f "$0") rollback $RECEIPT"; fi
  state rollback_command "$cmd"; state shepherd "$SHEPHERD"; state failed_phase "$PHASE"
  log "FAILED, stopped for the shepherd ($SHEPHERD): $1. Nothing rolled back or restarted: current -> $(readlink "$PROD/current"), $UNIT $unit_state, $CONNECTOR_UNIT $conn_state."
  log "next step (shepherd runs it on a decision): $cmd"
  alert "FAILED in phase $PHASE: $1. Stopped, nothing rolled back or restarted; $UNIT is $unit_state on $(readlink "$PROD/current"); deliveries paused. Shepherd: $SHEPHERD. Next step: '$cmd'.$([[ "$PHASE" == installed ]] && echo " Or accept after manual checks: 'resume-deliveries $RECEIPT --checks-done <ref> --decision <ref>'.")"
  finish "FAILED (stopped, not rolled back; shepherd $SHEPHERD): $1. Next step: $cmd" 1
}

resolve_paths() {
  local exec_start env_file
  exec_start=$(systemctl --user show -p ExecStart --value "$UNIT")
  env_file=$(systemctl --user show -p EnvironmentFiles --value "$UNIT" | awk '{print $1}')
  [[ "$exec_start" == *"$PROD/current/t3 serve"* ]] || return 1
  [[ "$exec_start" == *"--port $PORT"* ]] || return 1
  [[ "$exec_start" == *"--base-dir $PROD/data"* ]] || return 1
  [[ "$env_file" == "$PROD/config/service.env" ]] || return 1
  [[ -d "$PROD/data" && -d "$PROD/data-lhc" && -d "$PROD/config" && -L "$PROD/current" ]]
}

cmd_plan() {
  RECEIPT=$(mktemp -d); trap 'rm -rf "$RECEIPT"' EXIT
  resolve_paths || { echo "unit $UNIT doesn't match the expected prod layout" >&2; exit 1; }
  echo "unit:              $UNIT ($(systemctl --user is-active "$UNIT"))"
  echo "current release:   $(readlink "$PROD/current")"
  echo "install release:   $RELEASE_NAME (commit $EXPECTED_COMMIT)"
  echo "artifact sha256:   $(sha256sum "$ARTIFACT" | cut -c1-64) (expected $EXPECTED_SHA256)"
  echo "migrations:        applied up to $(migrations | awk '{print $NF}'); expected new: $EXPECTED_NEW_MIGRATIONS"
  echo "service.env keys:  $(grep -o '^[A-Za-z0-9_]*=' "$PROD/config/service.env" | tr -d = | tr '\n' ' ')"
  echo "backup scope:      $PROD/{config,data,data-lhc,current} + unit file -> $BACKUPS/"
  echo "backup size:       $(du -sch "$PROD/config" "$PROD/data" "$PROD/data-lhc" | tail -1 | cut -f1); free on disk: $(df -h "$PROD" | awk 'NR==2{print $4}')"
  echo "connector:         $CONNECTOR_UNIT ($(systemctl --user is-active "$CONNECTOR_UNIT")) is stopped and stays stopped until resume-deliveries"
  echo "other connectors:  comms-legacy -> :3773, comms-jess -> :14067 (not prod; untouched)"
  echo "comms lines:       ${COMMS_LINES[*]%%=*} (only with --apply-comms)"
  echo "sessions now:      $(session_ids | wc -l)"
  echo "this shell's cgroup: $(cut -d: -f3 /proc/$$/cgroup)"
}

own_unit() { # own_unit <unit> <subcommand> [args]: run this script in its own transient unit.
  # Stopping t3code-lim-prod (KillMode=control-group) kills every process in its cgroup, including
  # an agent shell that invoked this script, so anything that stops prod must not run there.
  local unit=$1 v setenv=(); shift
  for v in "${OVERRIDABLE[@]}" JESS_DEPLOY_FAULT; do [[ -n "${!v:-}" ]] && setenv+=(--setenv="$v=${!v}"); done
  systemd-run --user --unit="$unit" --collect --property=MemoryMax=2G "${setenv[@]}" \
    "$(readlink -f "$0")" "$@"
}
not_in_prod_cgroup() { [[ "$(cut -d: -f3 /proc/$$/cgroup)" != *"/$UNIT.service"* ]]; }

cmd_launch() {
  local approved="" headsup=0 comms=0 v
  while (($#)); do case $1 in
    --approved) approved=$2; shift 2 ;;
    --heads-up-sent) headsup=1; shift ;;
    --apply-comms) comms=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac; done
  [[ -n "$approved" ]] || { echo "--approved \"<Lee's OK, relayed by Mira: message link>\" is required" >&2; exit 2; }
  ((headsup)) || { echo "--heads-up-sent is required (prod agents were told the restart is coming; Lee does not require them to be idle)" >&2; exit 2; }
  local open; if open=$(previous_open); then echo "refusing launch: $open; nothing changed" >&2; exit 1; fi
  take_lock launch || exit 1; exec 9>&-
  local ts unit; ts=$(date -u +%Y%m%dT%H%M%S%NZ); ts=${ts:0:19}Z; unit=jess-prod-deploy-$ts
  own_unit "$unit" run "$ts" "$approved" "$comms"
  echo "started $unit; receipt: $RECEIPTS/$ts/ (follow: journalctl --user -u $unit -f)"
}

cmd_run() {
  local ts=$1 approved=$2 comms=$3
  RECEIPT=$RECEIPTS/$ts; mkdir -p "$RECEIPT/private"
  trap 'LAST_CMD="line $LINENO: $BASH_COMMAND"' ERR
  trap 'on_exit $?' EXIT
  state started "$ts"; state approved "$approved"; state candidate_run "$CANDIDATE_RUN"; state started_at "$(date "+%F %T")"
  state target "$(target_id)"
  take_lock deploy 2>>"$RECEIPT/receipt.log" || handle_failure "another prod-deploy operation holds the lock"
  local open; if open=$(previous_open "$ts"); then handle_failure "$open"; fi

  # 1. Preflight (nothing changed yet)
  log "deploy unit cgroup: $(cut -d: -f3 /proc/$$/cgroup)"
  not_in_prod_cgroup || handle_failure "running inside $UNIT's cgroup"
  resolve_paths || handle_failure "unit $UNIT doesn't match the expected prod layout"
  [[ "$(sha256sum "$ARTIFACT" | cut -c1-64)" == "$EXPECTED_SHA256" ]] || handle_failure "artifact hash mismatch"
  mkdir -p "$BACKUPS"
  local free_kb; free_kb=$(df -Pk "$BACKUPS" | awk 'NR==2{print $4}')
  ((free_kb > 5 * 1024 * 1024)) || handle_failure "less than 5 GB free"
  OLD_RELEASE=$(readlink "$PROD/current"); state old_release "$OLD_RELEASE"
  MIG_BEFORE=$(migrations); state migrations_before "$MIG_BEFORE"
  cp -p "$PROD/config/service.env" "$RECEIPT/private/service.env.before"
  systemctl --user cat "$UNIT" > "$RECEIPT/private/unit.before"
  state artifact "$ARTIFACT"; state artifact_sha256 "$EXPECTED_SHA256"; state new_release "$RELEASE_NAME"; state new_commit "$EXPECTED_COMMIT"
  log "preflight ok: old=$OLD_RELEASE new=$RELEASE_NAME artifact sha256 $EXPECTED_SHA256; migrations up to ${MIG_BEFORE##* }"

  # 2. Pause deliveries, then stop prod. From here a failure stops for the shepherd (T-8): nothing is
  #    restarted; the receipt names restart-unchanged, which the shepherd runs on a decision.
  PHASE=stopped
  svc_stop "$CONNECTOR_UNIT" || handle_failure "connector did not stop"
  log "connector stopped (deliveries pause in comms)"; state deliveries paused
  svc_stop "$UNIT" || handle_failure "prod did not stop"
  log "prod stopped"
  # Baselines from the stopped state, so they match the backup and nothing running can move them (Macroscope, #22).
  local sessions_before; sessions_before=$(session_ids | sha256sum | cut -c1-16)
  state sessions_before "$sessions_before"
  native_refs > "$RECEIPT/native-refs-before.json"
  log "native refs snapshot: $(python3 -I -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$RECEIPT/native-refs-before.json") provider rows"

  # 3. Cold backup of config, data, data-lhc and the current link; verify by test restore
  local backup=$BACKUPS/pre-$CANDIDATE_RUN-$ts.tar.gz t
  if [[ "$FAULT" == backup_fails ]]; then log "injected fault: backup fails"; false; fi
  tar -C "$PROD" -czf "$backup" config data data-lhc current
  sha256sum "$backup" > "$backup.sha256"
  sha256sum -c --quiet "$backup.sha256" || handle_failure "backup checksum"
  t=$(mktemp -d)
  tar -C "$t" -xzf "$backup"
  if ! (cd "$PROD" && diff -rq --no-dereference config "$t/config" && diff -rq data "$t/data" \
    && diff -rq data-lhc "$t/data-lhc" && [[ "$(readlink current)" == "$(readlink "$t/current")" ]]); then
    rm -rf "$t"; handle_failure "backup verification failed"
  fi
  rm -rf "$t"; state backup "$backup"; state backup_sha256 "$(cut -c1-64 "$backup.sha256")"
  log "backup verified: $backup ($(tar -tzf "$backup" | wc -l) entries, sha256 $(cut -c1-64 "$backup.sha256"))"
  # A link repoint alone is not a rollback once 57/58 have run; this restores the release and its data together.
  state rollback_command "$(readlink -f "$0") rollback $RECEIPT"
  log "rollback (release + pre-migration data together): $(readlink -f "$0") rollback $RECEIPT"

  # 4-7. Install, configure, start, check. From here a failure stops for the shepherd (T-8): nothing is
  #    rolled back; the receipt names rollback (release and data together), which the shepherd runs on a decision.
  PHASE=installed
  tar -C "$PROD/releases" -xzf "$ARTIFACT"
  local commit; commit=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["commit"])' "$PROD/releases/$RELEASE_NAME/release.json")
  [[ "$commit" == "$EXPECTED_COMMIT" ]] || handle_failure "release.json commit $commit"
  ln -sfn "releases/$RELEASE_NAME" "$PROD/current"; log "current -> releases/$RELEASE_NAME"
  if [[ "$comms" == 1 ]]; then
    grep -v '^COMMS_' "$RECEIPT/private/service.env.before" > "$PROD/config/service.env.new"
    printf '%s\n' "${COMMS_LINES[@]}" >> "$PROD/config/service.env.new"
    chmod 600 "$PROD/config/service.env.new"; mv -f "$PROD/config/service.env.new" "$PROD/config/service.env"
    log "service.env: COMMS_* applied (keys: ${COMMS_LINES[*]%%=*})"; state comms_applied yes
  fi
  local started; started=$(date -u +%FT%TZ)
  systemctl --user start "$UNIT" || handle_failure "prod did not start"
  wait_http || handle_failure "prod not answering HTTP 200 within ${HEALTH_TIMEOUT}s"
  journalctl --user -u "$UNIT" --since "$started" --no-pager | grep -i -E "migrat" | cut -c1-240 > "$RECEIPT/migrations.log" || true
  # Migrations: every expected one is recorded as applied, and nothing before it was lost.
  local mig_after m; mig_after=$(migrations); state migrations_after "$mig_after"
  [[ " $mig_after " == " $MIG_BEFORE "* ]] || handle_failure "pre-deploy migrations missing after start"
  for m in $EXPECTED_NEW_MIGRATIONS; do
    [[ " $mig_after " == *" $m "* ]] || handle_failure "migration $m not recorded as applied"
  done
  log "migrations applied: $(migration_names $EXPECTED_NEW_MIGRATIONS) (now up to ${mig_after##* })"
  # Auth state preserved: the same sessions exist after the upgrade.
  [[ "$(session_ids | sha256sum | cut -c1-16)" == "$sessions_before" ]] || handle_failure "auth sessions changed across the upgrade"
  log "auth sessions unchanged ($(session_ids | wc -l) ids)"
  if [[ "$comms" == 1 ]]; then
    local tok cfg
    tok=$(T3 auth session issue --base-dir "$PROD/data" --label "jess deploy check" --ttl 10m --token-only)
    cfg=$(curl -s --connect-timeout 2 --max-time 10 -H "authorization: Bearer $tok" "http://127.0.0.1:$PORT/api/comms/config" || true)
    unset tok
    [[ "$cfg" == *'"enabled":true'* && "$cfg" == *'"homeMachine":"lim-builder"'* ]] || handle_failure "comms config not enabled"
    log "comms config: enabled, homeMachine lim-builder"
  fi

  # 8. Deliveries stay paused until a person runs the manual checks and resume-deliveries.
  PHASE=done
  finish "installed $RELEASE_NAME; deliveries PAUSED until the manual checks pass and resume-deliveries $RECEIPT runs" 0
}

cmd_resume() {
  RECEIPT=$1; shift
  [[ -f "$RECEIPT/receipt.json" ]] || { echo "no receipt in $RECEIPT" >&2; exit 2; }
  local checks="" decision=""
  while (($#)); do case $1 in
    --checks-done) checks=${2:-}; shift 2 ;;
    --decision) decision=${2:-}; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac; done
  [[ -n "$checks" ]] || { echo "--checks-done \"<who checked, link>\" is required" >&2; exit 2; }
  check_target resume-deliveries || exit 1; check_latest resume-deliveries || exit 1
  take_lock resume-deliveries || exit 1
  local result want accept=0; result=$(receipt_get result)
  case $result in
    installed*) want="releases/$(receipt_get new_release)" ;;
    "rolled back"* | "restarted unchanged") want=$(receipt_get old_release) ;;
    "FAILED (stopped, not rolled back"*)
      [[ "$(receipt_get failed_phase)" == installed ]] || { echo "receipt says '$result' before install; run its restart-unchanged step first" >&2; exit 1; }
      # Accepting a release whose check failed is a decision, recorded like one.
      [[ -n "$decision" ]] || { echo "receipt says '$result'; resuming needs --decision \"<who decided, link>\"" >&2; exit 1; }
      want="releases/$(receipt_get new_release)"; accept=1 ;;
    *) echo "receipt result is '$result'; not resuming" >&2; exit 1 ;;
  esac
  # The receipt must describe what is installed now, not an earlier state (Macroscope, #22).
  [[ "$(readlink "$PROD/current")" == "$want" ]] || { echo "refusing resume-deliveries: current is $(readlink "$PROD/current"), the receipt expects $want; nothing changed" >&2; exit 1; }
  if ((accept)); then
    state decision "accepted as installed: $decision"; log "decision recorded: accept as installed ($decision)"
    # Part of the shepherd's explicit accept, never on its own: an accepted release left down is started (Codex, #22).
    if [[ "$(systemctl --user is-active "$UNIT" || true)" != active ]]; then
      log "starting $UNIT as part of the accept decision"; systemctl --user start "$UNIT" || { log "resume refused: $UNIT did not start"; exit 1; }
    fi
  fi
  set -- "$checks"
  wait_http || { log "resume refused: prod is not answering"; exit 1; }
  local cstart; cstart=$(date -u +%FT%TZ)
  systemctl --user start "$CONNECTOR_UNIT"
  if timeout "$ATTACH_TIMEOUT" bash -c "until journalctl --user -u $CONNECTOR_UNIT --since '$cstart' --no-pager | grep -q 'T3 adapter: http://127.0.0.1:$PORT'; do sleep 2; done"; then
    log "deliveries resumed after checks ($1); connector attached to prod T3"; state deliveries "resumed: $1"
  else
    # Stop it again so it can't attach later and release deliveries the receipt says are paused (Codex, #22).
    if svc_stop "$CONNECTOR_UNIT"; then
      log "connector started but did not attach to prod T3 within ${ATTACH_TIMEOUT}s; stopped it again, deliveries paused"; state deliveries "paused (resume failed: connector did not attach)"
    else
      log "connector started but did not attach to prod T3 within ${ATTACH_TIMEOUT}s, and did not stop; needs a person"; state deliveries "resume failed; connector may be running"
    fi
    exit 1
  fi
}

cmd_verify_identity() { # T-9: every provider row keeps its pre-deploy native ref; no fresh-session fallback
  RECEIPT=$1; [[ -f "$RECEIPT/native-refs-before.json" ]] || { echo "no native-refs-before.json in $RECEIPT" >&2; exit 2; }
  check_target verify-identity || exit 1
  native_refs > "$RECEIPT/native-refs-after.json"
  local changed fallbacks since
  changed=$(python3 -I - "$RECEIPT/native-refs-before.json" "$RECEIPT/native-refs-after.json" <<'EOF2'
import json, sys
a, b = (json.load(open(x)) for x in sys.argv[1:])
for k, v in sorted(a.items()):
    # Native id and strength both count: strong -> weak changes later failures to fallbacks.
    if v[1] and (k not in b or b[k][1:] != v[1:]):
        after = b.get(k, [None, "MISSING", None])
        print(f"{v[0]} {v[1]}/{v[2]} -> {after[1]}/{after[2]}")
EOF2
)
  since=$(receipt_get started_at); [[ -n "$since" ]] || since=$(receipt_get started)
  # Both a silent fresh-session fallback (lim.5) and a fail-and-keep resume failure (#22) are a binding
  # that did not resume, so both go to triage. An unreadable journal is a FAIL, never 0 (Quinn, #22 A2).
  # stdout only: an exit-0 stderr hint ("No journal files were opened") must not count as an entry.
  local journal failures jerr; jerr=$(mktemp)
  if ! journal=$("$JOURNALCTL" --user -u "$UNIT" --since "${since:-today}" --no-pager -o cat 2>"$jerr"); then
    log "identity check FAIL (goes to fleet triage, T-9): could not read $UNIT's journal: $(head -c 200 "$jerr")"; rm -f "$jerr"
    state identity "FAIL"; exit 1
  fi
  rm -f "$jerr"
  # journalctl exits 0 with no output for a wrong unit, a wrong --since or a non-persistent journal
  # (Quinn, #22 re-review). Prod has just started, so it must have logged something since then.
  if ! grep -v -x -e '' -e '-- No entries --' <<<"$journal" | grep -q .; then
    log "identity check FAIL (goes to fleet triage, T-9): no journal entries from $UNIT since $since, so nothing was searched"
    state identity "FAIL"; exit 1
  fi
  fallbacks=$(grep -c "Provider resume failed; attempting a fresh native session" <<<"$journal" || true)
  failures=$(grep -c "Native session resume failed" <<<"$journal" || true)
  if [[ -z "$changed" && "$fallbacks" == 0 && "$failures" == 0 ]]; then
    log "identity check PASS: $(python3 -I -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$RECEIPT/native-refs-before.json") native refs unchanged, no fresh-session fallback since $since"
    state identity "pass"
  else
    log "identity check FAIL (goes to fleet triage, T-9): changed refs: ${changed:-none}; fresh-session fallbacks in journal: $fallbacks; resume failures (binding kept) in journal: $failures"
    state identity "FAIL"; exit 1
  fi
}

cmd_restart_unchanged() { # shepherd's step after a failure before install: start the same old release again
  RECEIPT=$1; [[ -f "$RECEIPT/receipt.json" ]] || { echo "no receipt in ${1:-}" >&2; exit 2; }
  check_target restart-unchanged || exit 1; check_latest restart-unchanged || exit 1
  take_lock restart-unchanged || exit 1
  OLD_RELEASE=$(receipt_get old_release); MIG_BEFORE=$(receipt_get migrations_before)
  [[ "$(readlink "$PROD/current")" == "$OLD_RELEASE" ]] || { log "refusing restart-unchanged: current is not $OLD_RELEASE; use rollback"; exit 1; }
  [[ "$(migrations)" == "$MIG_BEFORE" ]] || { log "refusing restart-unchanged: migrations differ from the pre-deploy set; use rollback"; exit 1; }
  systemctl --user start "$UNIT" || { log "restart-unchanged: $UNIT did not start"; exit 1; }
  if wait_http; then
    state result "restarted unchanged"; log "restarted $OLD_RELEASE unchanged; deliveries stay paused until resume-deliveries"
  else
    state result "RESTART FAILED"; log "restart-unchanged: no HTTP 200; needs a person"; exit 1
  fi
}

cmd_close_receipt() { # shepherd: mark a deploy closed after a manual recovery, so a new launch may proceed
  RECEIPT=$(readlink -f "${1:-}"); shift || true
  # A receipt folder whose receipt.json is missing still counts as open, so it must be closable (Quinn, #22).
  [[ -f "$RECEIPT/receipt.json" || ( -d "$RECEIPT" && "$(basename "$RECEIPT")" == [0-9]*Z ) ]] || { echo "no receipt in ${RECEIPT:-}" >&2; exit 2; }
  [[ "${1:-}" == --decision && -n "${2:-}" ]] || { echo "close-receipt <receipt-dir> --decision \"<who decided, link>\" is required" >&2; exit 2; }
  take_lock close-receipt || exit 1
  local was; was="$(receipt_get result 2>/dev/null || echo '(no receipt.json)'); deliveries: $(receipt_get deliveries 2>/dev/null || echo -)"
  state closed "$2"; log "closed by the shepherd: $2 (state was: $was)"
}
cmd_rollback() { # starts rollback-run in its own unit, so it survives stopping prod; then exits
  local receipt; receipt=$(readlink -f "${1:-}")
  [[ -f "$receipt/receipt.json" ]] || { echo "no receipt in ${1:-}" >&2; exit 2; }
  RECEIPT=$receipt; check_target rollback || exit 1; check_latest rollback || exit 1
  take_lock rollback || exit 1; exec 9>&-
  local ts unit; ts=$(date -u +%Y%m%dT%H%M%S%NZ); unit=jess-prod-rollback-${ts:0:19}Z
  own_unit "$unit" rollback-run "$receipt"
  echo "started $unit; log: $receipt/receipt.log (follow: journalctl --user -u $unit -f)"
}

cmd_rollback_run() {
  RECEIPT=$1; [[ -f "$RECEIPT/receipt.json" ]] || { echo "no receipt in $RECEIPT" >&2; exit 2; }
  # The shepherd already saw 'started'; a refusal here goes into the receipt and an alert (Quinn, #22).
  local refusal
  if ! refusal=$({ check_target rollback-run && check_latest rollback-run; } 2>&1); then
    state rollback "refused, nothing changed: $refusal"; log "rollback refused, nothing changed: $refusal"
    alert "Rollback of $RECEIPT refused, nothing changed: $refusal"; exit 1
  fi
  take_lock rollback-run || { state rollback "refused, nothing changed: lock taken"; log "rollback refused: lock taken"; alert "Rollback of $RECEIPT refused, nothing changed: another prod-deploy operation holds the lock"; exit 1; }
  log "rollback by hand, running in cgroup: $(cut -d: -f3 /proc/$$/cgroup)"
  not_in_prod_cgroup || { log "refusing: rollback-run is inside $UNIT's cgroup and would be killed with it; use rollback"; exit 1; }
  OLD_RELEASE=$(receipt_get old_release); MIG_BEFORE=$(receipt_get migrations_before)
  svc_stop "$CONNECTOR_UNIT" || { log "could not stop the connector; not rolling back"; exit 1; }
  if restore_backup "$(receipt_get backup)"; then
    state result "rolled back by hand"; log "rolled back by hand; deliveries stay paused until resume-deliveries"
  else
    state result "ROLLBACK FAILED (by hand)"; log "rollback by hand failed; needs a person"; exit 1
  fi
}

case ${1:-plan} in
  plan) cmd_plan ;;
  launch) shift; cmd_launch "$@" ;;
  run) shift; cmd_run "$@" ;;
  resume-deliveries) shift; cmd_resume "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  rollback-run) shift; cmd_rollback_run "$@" ;;
  restart-unchanged) shift; cmd_restart_unchanged "$@" ;;
  close-receipt) shift; cmd_close_receipt "$@" ;;
  verify-identity) shift; cmd_verify_identity "$@" ;;
  *) echo "usage: $0 plan | launch --approved <ref> --heads-up-sent [--apply-comms] | resume-deliveries <receipt-dir> --checks-done <ref> [--decision <ref>] | rollback <receipt-dir> | restart-unchanged <receipt-dir> | close-receipt <receipt-dir> --decision <ref> | verify-identity <receipt-dir>" >&2; exit 2 ;;
esac
