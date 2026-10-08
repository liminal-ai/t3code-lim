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
#                                                 (like launch) in its own transient unit
#
# No automated rollback (Lee, 2026-10-08 07:54 ET, via @mira #153): a failed check after
# install stops, keeps all state, records the receipt and alerts. Rolling back is the explicit
# `rollback` command, run by the shepherd on a decision. Deliveries stay paused (connector
# stopped) after every outcome except a failure before anything changed; only
# `resume-deliveries` releases queued work. Every step appends to
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
# Where a stop is announced ("none" disables; the isolated tests use none).
ALERT_ISSUE=${ALERT_ISSUE:-liminal-ai/t3code-lim#12}
ALERT_TO=${ALERT_TO:-mira}
OVERRIDABLE=(CANDIDATE_RUN EXPECTED_COMMIT RELEASE_NAME ARTIFACT EXPECTED_SHA256 EXPECTED_NEW_MIGRATIONS
  UNIT PROD PORT CONNECTOR_UNIT BACKUPS RECEIPTS HEALTH_TIMEOUT ALERT_ISSUE ALERT_TO)
FAULT=${JESS_DEPLOY_FAULT:-}
if [[ -n "$FAULT" && "$PROD" == "$REAL_PROD" ]]; then echo "fault injection is refused against real prod" >&2; exit 2; fi

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
receipt_get() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$RECEIPT/receipt.json" "$1"; }
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
    stopped) recover_old "$1" ;;
    installed) hold_for_decision "$1" ;;
  esac
  finish "failed: $1" 1
}
recover_old() { # failed while prod was stopped and before install: release and data are unchanged
  if [[ "$(readlink "$PROD/current")" != "$OLD_RELEASE" ]]; then
    finish "FAILED: $1; current link changed unexpectedly, prod left stopped, deliveries paused. Needs a person." 1
  fi
  if systemctl --user start "$UNIT" && wait_http; then
    log "prod restarted on the old release, unchanged (nothing was installed)"
    alert "failed before install: $1. Prod restarted on $OLD_RELEASE unchanged; deliveries paused."
    finish "failed: $1; prod restarted on $OLD_RELEASE unchanged; deliveries PAUSED until resume-deliveries $RECEIPT" 1
  fi
  alert "failed before install: $1. Prod did NOT restart on the old release; deliveries paused. Needs a person."
  finish "FAILED: $1; prod did not restart on the old release; deliveries paused. Needs a person." 1
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
  if [[ "$ALERT_TO" != none ]]; then
    timeout 30 comms send --as jess --continue "@$ALERT_TO" "$text" >/dev/null 2>&1 \
      && log "alert sent to @$ALERT_TO" || log "alert: comms to @$ALERT_TO failed (connector may be stopped)"
  fi
}
hold_for_decision() { # a check failed after install: stop here, change nothing, ask for a decision
  local unit_state; unit_state=$(systemctl --user is-active "$UNIT" || true)
  log "STOPPED for a decision: $1. Nothing rolled back: current -> $(readlink "$PROD/current"), $UNIT $unit_state, deliveries paused."
  alert "STOPPED after install: $1. Not rolled back; $UNIT is $unit_state on $(readlink "$PROD/current"). Decide: roll back with '$(readlink -f "$0") rollback $RECEIPT', or accept after manual checks with 'resume-deliveries $RECEIPT --checks-done <ref> --decision <ref>'."
  finish "STOPPED for a decision: $1. Not rolled back; deliveries paused. Roll back: $(readlink -f "$0") rollback $RECEIPT" 1
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
  local ts unit; ts=$(date -u +%Y%m%dT%H%M%S%NZ); ts=${ts:0:19}Z; unit=jess-prod-deploy-$ts
  own_unit "$unit" run "$ts" "$approved" "$comms"
  echo "started $unit; receipt: $RECEIPTS/$ts/ (follow: journalctl --user -u $unit -f)"
}

cmd_run() {
  local ts=$1 approved=$2 comms=$3
  RECEIPT=$RECEIPTS/$ts; mkdir -p "$RECEIPT/private"
  trap 'LAST_CMD="line $LINENO: $BASH_COMMAND"' ERR
  trap 'on_exit $?' EXIT
  state started "$ts"; state approved "$approved"; state candidate_run "$CANDIDATE_RUN"

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
  local sessions_before; sessions_before=$(session_ids | sha256sum | cut -c1-16)
  state sessions_before "$sessions_before"
  state artifact "$ARTIFACT"; state artifact_sha256 "$EXPECTED_SHA256"; state new_release "$RELEASE_NAME"; state new_commit "$EXPECTED_COMMIT"
  log "preflight ok: old=$OLD_RELEASE new=$RELEASE_NAME artifact sha256 $EXPECTED_SHA256; migrations up to ${MIG_BEFORE##* }"

  # 2. Pause deliveries, then stop prod. From here a failure restarts the old release.
  PHASE=stopped
  svc_stop "$CONNECTOR_UNIT" || handle_failure "connector did not stop"
  log "connector stopped (deliveries pause in comms)"; state deliveries paused
  svc_stop "$UNIT" || handle_failure "prod did not stop"
  log "prod stopped"

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

  # 4-7. Install, configure, start, check. From here a failure restores the release and data together.
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
  local result; result=$(receipt_get result)
  case $result in
    installed* | "rolled back"* | "failed: "*"unchanged"*) ;;
    "STOPPED for a decision"*)
      # Accepting a release whose check failed is a decision, recorded like one.
      [[ -n "$decision" ]] || { echo "receipt says '$result'; resuming needs --decision \"<who decided, link>\"" >&2; exit 1; }
      state decision "accepted as installed: $decision"; log "decision recorded: accept as installed ($decision)" ;;
    *) echo "receipt result is '$result'; not resuming" >&2; exit 1 ;;
  esac
  set -- "$checks"
  wait_http || { log "resume refused: prod is not answering"; exit 1; }
  local cstart; cstart=$(date -u +%FT%TZ)
  systemctl --user start "$CONNECTOR_UNIT"
  if timeout 60 bash -c "until journalctl --user -u $CONNECTOR_UNIT --since '$cstart' --no-pager | grep -q 'T3 adapter: http://127.0.0.1:$PORT'; do sleep 2; done"; then
    log "deliveries resumed after checks ($1); connector attached to prod T3"; state deliveries "resumed: $1"
  else
    log "connector started but did not attach to prod T3 within 60 s"; state deliveries "resume failed"; exit 1
  fi
}

cmd_rollback() { # starts rollback-run in its own unit, so it survives stopping prod; then exits
  local receipt; receipt=$(readlink -f "${1:-}")
  [[ -f "$receipt/receipt.json" ]] || { echo "no receipt in ${1:-}" >&2; exit 2; }
  local ts unit; ts=$(date -u +%Y%m%dT%H%M%S%NZ); unit=jess-prod-rollback-${ts:0:19}Z
  own_unit "$unit" rollback-run "$receipt"
  echo "started $unit; log: $receipt/receipt.log (follow: journalctl --user -u $unit -f)"
}

cmd_rollback_run() {
  RECEIPT=$1; [[ -f "$RECEIPT/receipt.json" ]] || { echo "no receipt in $RECEIPT" >&2; exit 2; }
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
  *) echo "usage: $0 plan | launch --approved <ref> --heads-up-sent [--apply-comms] | resume-deliveries <receipt-dir> --checks-done <ref> [--decision <ref>] | rollback <receipt-dir>" >&2; exit 2 ;;
esac
