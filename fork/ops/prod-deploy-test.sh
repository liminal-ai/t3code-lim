#!/usr/bin/env bash
# Isolated failure tests for prod-deploy-t3.sh (Alder's review on #12). Each case builds a fake
# prod: its own user units (jess-fake-prod-<case>, jess-fake-connector-<case>), port, data,
# sqlite migrations table and release tarball, then runs the real script through `launch`
# (its own transient unit). Real prod, staging and the real connectors are never touched.
# Usage: prod-deploy-test.sh [case ...]   (default: all)   Output: one block per case.
set -euo pipefail
umask 077
DEPLOY=$(dirname "$(readlink -f "$0")")/prod-deploy-t3.sh
ROOT=$HOME/lim/agents/jess/test-agents/deploy-sandbox
UNITS=$HOME/.config/systemd/user
NEW=t3code-lim-fake-new-linux-x64
COMMIT=0000000000000000000000000000000000fake01

fake_t3() { # fake_t3 <release dir> [migrate]: a `t3` that serves HTTP and, if migrate, applies 57 and 58
  mkdir -p "$1"
  cat > "$1/t3" <<EOF
#!/usr/bin/env bash
root=\$(cd "\$(dirname "\$0")" && pwd)
case "\$1 \${2:-} \${3:-}" in
  "auth session list") cat "\$5/sessions.json"; exit ;;
esac
[ "\$1" = serve ] || exit 2
while [ \$# -gt 0 ]; do case \$1 in --port) port=\$2; shift 2 ;; --base-dir) base=\$2; shift 2 ;; *) shift ;; esac; done
[ -e "\$root/BROKEN" ] && { echo "fake: release is broken" >&2; exit 1; }
if [ "${2:-}" = migrate ]; then
  python3 -I -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executemany('insert or ignore into effect_sql_migrations(migration_id,name) values(?,?)',[(57,'ScheduledTaskWebhooks'),(58,'WebhookRelayDeliveries')]);c.commit()" "\$base/userdata/statev2.sqlite"
  echo "fake: Migrations ran successfully"
fi
exec python3 -I -m http.server "\$port" --bind 127.0.0.1 --directory "\$root"
EOF
  chmod 700 "$1/t3"
}

setup() { # setup <case> <port> <new release migrates: yes|no>
  local c=$1 port=$2 P=$ROOT/$1/prod
  teardown "$c" quiet
  mkdir -p "$P"/{config,data/userdata,data-lhc/threads,releases} "$ROOT/$c/backups" "$ROOT/$c/receipts" "$ROOT/$c/new"
  echo "PATH=/usr/bin:/bin" > "$P/config/service.env"
  echo '[{"sessionId":"s-1","connected":true},{"sessionId":"s-2","connected":false}]' > "$P/data/sessions.json"
  echo "fake registry" > "$P/data-lhc/registry.sqlite"
  python3 -I -c "
import sqlite3,sys;c=sqlite3.connect(sys.argv[1])
c.execute('create table effect_sql_migrations(migration_id integer primary key not null, created_at datetime not null default current_timestamp, name varchar(255) not null)')
c.executemany('insert into effect_sql_migrations(migration_id,name) values(?,?)',[(i,f'm{i}') for i in range(1,57)]);c.commit()" "$P/data/userdata/statev2.sqlite"
  fake_t3 "$P/releases/t3code-lim-fake-old-linux-x64"
  ln -s releases/t3code-lim-fake-old-linux-x64 "$P/current"
  fake_t3 "$ROOT/$c/new/$NEW" "$([ "$3" = yes ] && echo migrate)"
  echo "{\"commit\":\"$COMMIT\"}" > "$ROOT/$c/new/$NEW/release.json"
  tar -C "$ROOT/$c/new" -czf "$ROOT/$c/new.tar.gz" "$NEW"
  cat > "$UNITS/jess-fake-prod-$c.service" <<EOF
[Unit]
Description=Jess deploy-test fake prod ($c)
[Service]
Type=simple
EnvironmentFile=$P/config/service.env
# A queued trigger runs as a child of this unit, i.e. inside the fake prod's cgroup, like an agent shell on prod T3.
ExecStart=/bin/bash -c 'if [ -f $ROOT/$c/trigger ]; then mv $ROOT/$c/trigger $ROOT/$c/trigger.run; (bash $ROOT/$c/trigger.run >> $ROOT/$c/invoker.log 2>&1 &); fi; exec $P/current/t3 serve --host 127.0.0.1 --port $port --base-dir $P/data --no-browser'
KillMode=control-group
EOF
  cat > "$UNITS/jess-fake-connector-$c.service" <<EOF
[Unit]
Description=Jess deploy-test fake connector ($c)
[Service]
Type=simple
ExecStart=/bin/bash -c 'echo "fake T3 adapter: http://127.0.0.1:$port (orchestration protocol 2)"; exec sleep infinity'
EOF
  systemctl --user daemon-reload
  systemctl --user start "jess-fake-prod-$c" "jess-fake-connector-$c"
  timeout 20 bash -c "until curl -s -o /dev/null http://127.0.0.1:$port/; do sleep 0.5; done"
}

teardown() {
  systemctl --user stop "jess-fake-prod-$1" "jess-fake-connector-$1" 2>/dev/null || true
  rm -f "$UNITS/jess-fake-prod-$1.service" "$UNITS/jess-fake-connector-$1.service"
  systemctl --user daemon-reload
  [[ "${2:-}" == quiet ]] && rm -rf "${ROOT:?}/$1"
  return 0
}

deploy() { # deploy <case> <port> [fault] [after-stop hook]: launch and wait for the receipt's result
  local c=$1 port=$2 P=$ROOT/$1/prod
  export UNIT=jess-fake-prod-$c CONNECTOR_UNIT=jess-fake-connector-$c PROD=$P PORT=$port
  export BACKUPS=$ROOT/$c/backups RECEIPTS=$ROOT/$c/receipts HEALTH_TIMEOUT=15 CANDIDATE_RUN=test
  export ALERT_ISSUE=none ALERT_TO=none
  export RELEASE_NAME=$NEW ARTIFACT=$ROOT/$c/new.tar.gz EXPECTED_COMMIT=$COMMIT
  EXPECTED_SHA256=$(sha256sum "$ARTIFACT" | cut -c1-64); export EXPECTED_SHA256
  if [[ -n "${3:-}" ]]; then export JESS_DEPLOY_FAULT=$3; else unset JESS_DEPLOY_FAULT; fi
  R=$("$DEPLOY" launch --approved "isolated test $c" --heads-up-sent 2>/dev/null | grep -o 'receipt: [^ ]*' | cut -d' ' -f2)
  timeout 120 bash -c "until python3 -I -c 'import json,sys;sys.exit(0 if \"result\" in json.load(open(sys.argv[1])) else 1)' '$R/receipt.json' 2>/dev/null; do sleep 1; done"
}

report() { # report <case> <port>
  local c=$1 P=$ROOT/$1/prod
  echo "== $c"
  echo "result:     $(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$R/receipt.json")"
  echo "prod:       $(systemctl --user is-active "jess-fake-prod-$c" || true), HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$2/" || true), current -> $(readlink "$P/current")"
  echo "migrations: up to $(python3 -I -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select max(migration_id) from effect_sql_migrations').fetchone()[0])" "$P/data/userdata/statev2.sqlite")"
  echo "connector:  $(systemctl --user is-active "jess-fake-connector-$c" || true)"
  echo "set aside:  $(ls -d "$P"/failed-* 2>/dev/null | wc -l) failed-state dir(s); backups: $(ls "$ROOT/$c/backups"/*.tar.gz 2>/dev/null | wc -l)"
  echo "alert:      $(test -f "$R/ALERT.txt" && echo "yes ($(wc -l < "$R/ALERT.txt") line)" || echo no)"
  grep -o "cgroup: .*" "$R/receipt.log" | sed "s/^/ran in /"
  sed -E 's/^[0-9TZ:-]+ /  /' "$R/receipt.log" | grep -v 'cgroup:'
}

invoke_from_prod() { # invoke_from_prod <case> <command...>: run a command inside the fake prod's cgroup
  local c=$1; shift
  { echo 'echo "invoker cgroup: $(cut -d: -f3 /proc/$$/cgroup)"'
    for v in UNIT CONNECTOR_UNIT PROD PORT BACKUPS RECEIPTS HEALTH_TIMEOUT CANDIDATE_RUN RELEASE_NAME ARTIFACT EXPECTED_COMMIT EXPECTED_SHA256; do
      printf 'export %s=%q\n' "$v" "${!v}"; done
    printf '%q ' "$@"; echo; echo 'echo "invoker finished, exit $?"'; } > "$ROOT/$c/trigger"
  systemctl --user restart "jess-fake-prod-$c"
}
wait_result_change() { # wait_result_change <seconds>: until receipt.json's result changes from what it is now
  local before; before=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$R/receipt.json")
  timeout "$1" bash -c "until [ \"\$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))[\"result\"])' '$R/receipt.json')\" != '$before' ]; do sleep 1; done" || true
}
rollback_by_hand() { # rollback_by_hand <case>: the shepherd's explicit rollback after a stop
  echo "-- rollback by hand (shepherd's decision):"
  "$DEPLOY" rollback "$R" 2>/dev/null | sed 's/^/  /'; wait_result_change 90
}

run_case() {
  case $1 in
    happy)            # install succeeds; deliveries stay paused until resume-deliveries
      setup happy 18901 yes; deploy happy 18901; report happy 18901
      echo "-- resume-deliveries:"; "$DEPLOY" resume-deliveries "$R" --checks-done "test: manual checks stand-in" | sed 's/^[0-9TZ:-]* /  /'
      echo "connector:  $(systemctl --user is-active jess-fake-connector-happy || true)" ;;
    backup-fails)     # error during backup, nothing installed -> old release restarted unchanged, deliveries paused
      setup backup-fails 18902 yes; deploy backup-fails 18902 backup_fails; report backup-fails 18902 ;;
    migration-missing) # a check fails after install -> STOPPED, nothing rolled back, alert; then the shepherd's rollback
      setup migration-missing 18903 no; deploy migration-missing 18903; report migration-missing 18903
      echo "-- resume-deliveries without a decision is refused:"; "$DEPLOY" resume-deliveries "$R" --checks-done "test" 2>&1 | sed 's/^/  /' || true
      rollback_by_hand migration-missing; report migration-missing 18903
      echo "-- resume-deliveries after the rollback:"; "$DEPLOY" resume-deliveries "$R" --checks-done "test" | sed 's/^[0-9TZ:-]* /  /'
      echo "connector:  $(systemctl --user is-active jess-fake-connector-migration-missing || true)" ;;
    accept-stopped)   # a check fails after install -> STOPPED; the shepherd accepts the release instead, recorded as a decision
      setup accept-stopped 18908 no; deploy accept-stopped 18908; report accept-stopped 18908
      echo "-- resume-deliveries with a decision:"; "$DEPLOY" resume-deliveries "$R" --checks-done "test" --decision "test: accept" | sed 's/^[0-9TZ:-]* /  /'
      echo "connector:  $(systemctl --user is-active jess-fake-connector-accept-stopped || true)" ;;
    rollback-unhealthy) # STOPPED; the shepherd's rollback finds the old release won't restart -> ROLLBACK FAILED, deliveries paused
      setup rollback-unhealthy 18904 no
      touch "$ROOT/rollback-unhealthy/prod/releases/t3code-lim-fake-old-linux-x64/BROKEN" # running copy unaffected; a restart fails
      deploy rollback-unhealthy 18904; rollback_by_hand rollback-unhealthy; report rollback-unhealthy 18904
      echo "-- resume-deliveries is refused:"; "$DEPLOY" resume-deliveries "$R" --checks-done "test" 2>&1 | sed 's/^/  /' || true ;;
    restore-stop-fails) # STOPPED; the shepherd's rollback can't confirm prod stopped -> no data moved
      setup restore-stop-fails 18905 no; deploy restore-stop-fails 18905 restore_stop_fails
      rollback_by_hand restore-stop-fails; report restore-stop-fails 18905 ;;
    rollback-own-unit) # Alder: manual rollback invoked from inside prod's cgroup survives stopping prod
      setup rollback-own-unit 18906 yes; deploy rollback-own-unit 18906
      invoke_from_prod rollback-own-unit "$DEPLOY" rollback "$R"; wait_result_change 90
      report rollback-own-unit 18906; echo "-- invoker (inside fake prod):"; sed 's/^/  /' "$ROOT/rollback-own-unit/invoker.log" ;;
    rollback-rev2-control) # control: revision 2's rollback, same invocation, is killed with prod
      [[ -f /tmp/prod-deploy-t3.rev2.sh ]] || { echo "== rollback-rev2-control skipped (no revision 2 copy)"; return; }
      setup rollback-rev2-control 18907 yes; deploy rollback-rev2-control 18907
      install -m 700 /tmp/prod-deploy-t3.rev2.sh "$ROOT/rollback-rev2-control/prod-deploy-t3.rev2.sh"
      invoke_from_prod rollback-rev2-control "$ROOT/rollback-rev2-control/prod-deploy-t3.rev2.sh" rollback "$R"
      wait_result_change 40
      report rollback-rev2-control 18907; echo "-- invoker (inside fake prod):"; sed 's/^/  /' "$ROOT/rollback-rev2-control/invoker.log" ;;
  esac
  echo
}

CASES=("$@"); ((${#CASES[@]})) || CASES=(happy backup-fails migration-missing accept-stopped rollback-unhealthy restore-stop-fails rollback-own-unit rollback-rev2-control)
for c in "${CASES[@]}"; do run_case "$c"; done
for c in "${CASES[@]}"; do teardown "$c"; done
echo "fake units removed; sandbox kept in $ROOT for inspection"
