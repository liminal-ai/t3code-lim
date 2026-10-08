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
# HANG: a listener that accepts every connection and never answers (a T3 that is up but wedged while starting).
[ -e "\$root/HANG" ] && exec python3 -I -c "
import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(16)
held=[]
while True:
    c,_=s.accept(); held.append(c)  # keep every connection open, read nothing, write nothing
" "\$port"
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
c.execute('create table orchestration_v2_projection_provider_threads(provider_thread_id text primary key, thread_id text, payload_json text)')
import json
c.executemany('insert into orchestration_v2_projection_provider_threads values(?,?,?)',[(f'pt-{n}',f'thread-{n}',json.dumps(dict(nativeThreadRef=dict(driver='codex',nativeId=f'native-{n}',strength='strong')))) for n in ('a','b')])
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
  echo "prod:       $(systemctl --user is-active "jess-fake-prod-$c" || true), HTTP $(curl -s -o /dev/null --connect-timeout 2 --max-time 5 -w '%{http_code}' "http://127.0.0.1:$2/" || true), current -> $(readlink "$P/current")"
  echo "migrations: up to $(python3 -I -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select max(migration_id) from effect_sql_migrations').fetchone()[0])" "$P/data/userdata/statev2.sqlite")"
  echo "connector:  $(systemctl --user is-active "jess-fake-connector-$c" || true)"
  echo "set aside:  $(ls -d "$P"/failed-* 2>/dev/null | wc -l) failed-state dir(s); backups: $(ls "$ROOT/$c/backups"/*.tar.gz 2>/dev/null | wc -l)"
  echo "alert:      $(test -f "$R/ALERT.txt" && echo "yes ($(wc -l < "$R/ALERT.txt") line)" || echo no)"
  echo "shepherd:   $(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("shepherd","-"), "| rollback_command:", "yes" if d.get("rollback_command") else "no")' "$R/receipt.json")"
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
frozen() { # frozen <case>: after a FAILED stop, nothing changes over 5 s (current, units, data hash)
  local c=$1 P=$ROOT/$1/prod snap
  snap() { echo "$(readlink "$P/current") $(systemctl --user is-active "jess-fake-prod-$c" || true) $(systemctl --user is-active "jess-fake-connector-$c" || true) $(tar -C "$P" -cf - data | sha256sum | cut -c1-16)"; }
  local a; a=$(snap); sleep 5
  if [[ "$(snap)" == "$a" ]]; then FROZEN=yes; echo "frozen:     yes ($a)"; else FROZEN=NO; echo "frozen:     NO ($a -> $(snap))"; fi
}
# --- assertions (Quinn's review of #22, A1): every case states what it expects; any mismatch fails the run ---
FAILS=0; FAILED_CHECKS=()
check() { # check <label> <actual> <glob>
  if [[ "$2" == $3 ]]; then echo "  ok    $1"
  else echo "  FAIL  $1: got '$2', want '$3'"; FAILS=$((FAILS + 1)); FAILED_CHECKS+=("${CASE:-?}: $1"); fi
}
run_rc() { # run_rc <command...>: show the output, keep the exit code in RC and the output in OUT
  set +e; OUT=$("$@" 2>&1); RC=$?; set -e
  printf '%s\n' "$OUT" | sed -E 's/^[0-9TZ:-]+ /  /'
}
result_of() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("result",""))' "$R/receipt.json"; }
receipt_of() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$R/receipt.json" "$1"; }
active_of() { systemctl --user is-active "$1" 2>/dev/null || true; }
http_of() { curl -s -o /dev/null --connect-timeout 2 --max-time 5 -w '%{http_code}' "http://127.0.0.1:$1/" || true; }
current_of() { readlink "$ROOT/$1/prod/current"; }
mig_of() { python3 -I -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select max(migration_id) from effect_sql_migrations').fetchone()[0])" "$ROOT/$1/prod/data/userdata/statev2.sqlite"; }
setaside_of() { ls -d "$ROOT/$1/prod"/failed-* 2>/dev/null | wc -l; }
backups_of() { ls "$ROOT/$1/backups"/*.tar.gz 2>/dev/null | wc -l; }
stopped_checks() { # stopped_checks <case> <current> <migrations>: a FAILED stop changed nothing more and kept deliveries paused
  check "result is a FAILED stop" "$(result_of)" "FAILED (stopped, not rolled back; shepherd tux)*"
  check "current" "$(current_of "$1")" "releases/$2"
  check "migrations" "$(mig_of "$1")" "$3"
  check "connector paused" "$(active_of "jess-fake-connector-$1")" "inactive"
  check "alert written" "$(test -f "$R/ALERT.txt" && echo yes || echo no)" "yes"
  check "frozen" "$FROZEN" "yes"
}
rollback_by_hand() { # rollback_by_hand <case>: the shepherd's explicit rollback after a stop
  echo "-- rollback by hand (shepherd's decision):"
  "$DEPLOY" rollback "$R" 2>/dev/null | sed 's/^/  /'; wait_result_change 90
}

run_case() {
  CASE=$1; local c=$1 OLD=t3code-lim-fake-old-linux-x64
  case $1 in
    happy)            # install succeeds; deliveries stay paused until resume-deliveries; identity verified
      setup happy 18901 yes; deploy happy 18901; report happy 18901
      check "result" "$(result_of)" "installed $NEW; deliveries PAUSED*"
      check "prod" "$(active_of jess-fake-prod-$c) $(http_of 18901)" "active 200"
      check "current" "$(current_of $c)" "releases/$NEW"
      check "migrations" "$(mig_of $c)" "58"
      check "connector paused" "$(active_of jess-fake-connector-$c)" "inactive"
      check "backup taken" "$(backups_of $c)" "1"
      check "no alert" "$(test -f "$R/ALERT.txt" && echo yes || echo no)" "no"
      echo "-- resume-deliveries:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test: manual checks stand-in"
      check "resume-deliveries exit" "$RC" "0"
      check "connector after resume" "$(active_of jess-fake-connector-$c)" "active"
      echo "-- verify-identity:"; run_rc "$DEPLOY" verify-identity "$R"
      check "verify-identity exit" "$RC" "0"
      check "verify-identity says PASS" "$OUT" "*identity check PASS: 2 native refs unchanged*" ;;
    identity-changed) # a native ref changed after the deploy (the 2026-10-08 fallback) -> verify-identity FAILs
      setup identity-changed 18909 yes; deploy identity-changed 18909
      python3 -I -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"update orchestration_v2_projection_provider_threads set payload_json=replace(payload_json,'native-b','native-b-REPLACED') where provider_thread_id='pt-b'\");c.commit()" "$ROOT/identity-changed/prod/data/userdata/statev2.sqlite"
      echo "== identity-changed"; echo "-- verify-identity (native id changed):"; run_rc "$DEPLOY" verify-identity "$R"
      check "verify-identity exit (id changed)" "$RC" "1"
      check "names the changed ref" "$OUT" "*identity check FAIL*native-b/strong -> native-b-REPLACED/strong*"
      python3 -I -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"update orchestration_v2_projection_provider_threads set payload_json=replace(replace(payload_json,'native-b-REPLACED','native-b'),'strong','weak') where provider_thread_id='pt-b'\");c.commit()" "$ROOT/identity-changed/prod/data/userdata/statev2.sqlite"
      echo "-- verify-identity (same id, strong -> weak):"; run_rc "$DEPLOY" verify-identity "$R"
      check "verify-identity exit (downgraded)" "$RC" "1"
      check "names the downgrade" "$OUT" "*identity check FAIL*native-b/strong -> native-b/weak*"
      python3 -I -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"update orchestration_v2_projection_provider_threads set payload_json=replace(payload_json,'weak','strong') where provider_thread_id='pt-b'\");c.commit()" "$ROOT/identity-changed/prod/data/userdata/statev2.sqlite"
      echo "-- verify-identity (journal unreadable):"; run_rc env JOURNALCTL=/bin/false "$DEPLOY" verify-identity "$R"
      check "verify-identity exit (no journal)" "$RC" "1"
      check "says the journal could not be read" "$OUT" "*could not read*journal*"
      echo "-- verify-identity (journal empty):"; run_rc env JOURNALCTL=/bin/true "$DEPLOY" verify-identity "$R"
      check "verify-identity exit (empty journal)" "$RC" "1"
      check "says no journal entries" "$OUT" "*no journal entries from*" ;;
    backup-fails)     # error during backup, after prod was stopped -> FAILED, prod left stopped, nothing restarted
      setup backup-fails 18902 yes; deploy backup-fails 18902 backup_fails; report backup-fails 18902; frozen backup-fails
      stopped_checks $c $OLD 56
      check "prod left stopped" "$(active_of jess-fake-prod-$c)" "inactive"
      check "no backup" "$(backups_of $c)" "0"
      check "next step is restart-unchanged" "$(receipt_of rollback_command)" "*prod-deploy-t3.sh restart-unchanged *"
      echo "-- shepherd: restart-unchanged, then resume-deliveries:"
      run_rc "$DEPLOY" restart-unchanged "$R"; check "restart-unchanged exit" "$RC" "0"
      run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test"; check "resume-deliveries exit" "$RC" "0"
      check "prod and connector after" "$(active_of jess-fake-prod-$c) $(http_of 18902) $(active_of jess-fake-connector-$c)" "active 200 active"
      check "still the old release" "$(current_of $c)" "releases/$OLD" ;;
    migration-missing) # a check fails after install -> STOPPED, nothing rolled back, alert; then the shepherd's rollback
      setup migration-missing 18903 no; deploy migration-missing 18903; report migration-missing 18903; frozen migration-missing
      stopped_checks $c $NEW 56
      check "prod left running" "$(active_of jess-fake-prod-$c)" "active"
      check "next step is rollback" "$(receipt_of rollback_command)" "*prod-deploy-t3.sh rollback *"
      echo "-- resume-deliveries without a decision is refused:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test"
      check "resume without decision refused" "$RC" "1"
      check "connector still paused" "$(active_of jess-fake-connector-$c)" "inactive"
      rollback_by_hand migration-missing; report migration-missing 18903
      check "result after rollback" "$(result_of)" "rolled back by hand"
      check "prod after rollback" "$(active_of jess-fake-prod-$c) $(http_of 18903) $(current_of $c) $(mig_of $c)" "active 200 releases/$OLD 56"
      check "failed state set aside" "$(setaside_of $c)" "1"
      check "connector paused after rollback" "$(active_of jess-fake-connector-$c)" "inactive"
      echo "-- resume-deliveries after the rollback:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test"
      check "resume-deliveries exit" "$RC" "0"
      check "connector after resume" "$(active_of jess-fake-connector-$c)" "active" ;;
    accept-stopped)   # a check fails after install -> STOPPED; the shepherd accepts the release instead, recorded as a decision
      setup accept-stopped 18908 no; deploy accept-stopped 18908; report accept-stopped 18908
      check "result is a FAILED stop" "$(result_of)" "FAILED (stopped, not rolled back; shepherd tux)*"
      echo "-- resume-deliveries with a decision:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test" --decision "test: accept"
      check "resume-deliveries exit" "$RC" "0"
      check "decision recorded" "$OUT" "*decision recorded: accept as installed (test: accept)*"
      check "release kept" "$(current_of $c)" "releases/$NEW"
      check "connector after resume" "$(active_of jess-fake-connector-$c)" "active" ;;
    hanging-listener) # the new release accepts connections and never answers -> the bounded health check times out -> FAILED, nothing restarted
      setup hanging-listener 18910 yes
      touch "$ROOT/hanging-listener/new/$NEW/HANG"; tar -C "$ROOT/hanging-listener/new" -czf "$ROOT/hanging-listener/new.tar.gz" "$NEW"
      local t0=$SECONDS; deploy hanging-listener 18910; local took=$((SECONDS - t0))
      report hanging-listener 18910; frozen $c
      stopped_checks $c $NEW 56
      check "prod unit left as installed" "$(active_of jess-fake-prod-$c)" "active"
      check "health log" "$(cat "$R/receipt.log")" "*health check: no HTTP 200 within ${HEALTH_TIMEOUT}s (last code: 000)*"
      check "bounded: elapsed ${took}s vs timeout ${HEALTH_TIMEOUT}s" "$(( took >= HEALTH_TIMEOUT && took < HEALTH_TIMEOUT + 30 ))" "1"
      check "stop line" "$(cat "$R/receipt.log")" "*Nothing rolled back or restarted*"
      check "nothing restored or restarted" "$(grep -cE 'restored |prod back up|did not start|started after|restarted unchanged' "$R/receipt.log" || true)" "0"
      echo "-- resume-deliveries without a decision is refused:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test"
      check "resume-deliveries exit" "$RC" "1" ;;
    rollback-unhealthy) # STOPPED; the shepherd's rollback finds the old release won't restart -> ROLLBACK FAILED, deliveries paused
      setup rollback-unhealthy 18904 no
      touch "$ROOT/rollback-unhealthy/prod/releases/t3code-lim-fake-old-linux-x64/BROKEN" # running copy unaffected; a restart fails
      deploy rollback-unhealthy 18904; rollback_by_hand rollback-unhealthy; report rollback-unhealthy 18904
      check "result" "$(result_of)" "ROLLBACK FAILED (by hand)"
      check "connector paused" "$(active_of jess-fake-connector-$c)" "inactive"
      echo "-- resume-deliveries is refused:"; run_rc "$DEPLOY" resume-deliveries "$R" --checks-done "test"
      check "resume refused" "$RC" "1"
      check "connector still paused" "$(active_of jess-fake-connector-$c)" "inactive" ;;
    restore-stop-fails) # STOPPED; the shepherd's rollback can't confirm prod stopped -> no data moved
      setup restore-stop-fails 18905 no; deploy restore-stop-fails 18905 restore_stop_fails
      rollback_by_hand restore-stop-fails; report restore-stop-fails 18905
      check "result" "$(result_of)" "ROLLBACK FAILED (by hand)"
      check "no data moved" "$(current_of $c) $(mig_of $c) $(setaside_of $c)" "releases/$NEW 56 0"
      check "connector paused" "$(active_of jess-fake-connector-$c)" "inactive" ;;
    rollback-own-unit) # Alder: manual rollback invoked from inside prod's cgroup survives stopping prod
      setup rollback-own-unit 18906 yes; deploy rollback-own-unit 18906
      invoke_from_prod rollback-own-unit "$DEPLOY" rollback "$R"; wait_result_change 90
      report rollback-own-unit 18906; echo "-- invoker (inside fake prod):"; sed 's/^/  /' "$ROOT/rollback-own-unit/invoker.log"
      check "invoked from inside prod" "$(cat "$ROOT/$c/invoker.log")" "*invoker cgroup: */jess-fake-prod-rollback-own-unit.service*"
      check "result" "$(result_of)" "rolled back by hand"
      check "prod after rollback" "$(active_of jess-fake-prod-$c) $(http_of 18906) $(current_of $c) $(mig_of $c)" "active 200 releases/$OLD 56" ;;
    rollback-rev2-control) # control: revision 2's rollback, same invocation, is killed with prod
      [[ -f /tmp/prod-deploy-t3.rev2.sh ]] || { echo "== rollback-rev2-control skipped (no revision 2 copy)"; return; }
      setup rollback-rev2-control 18907 yes; deploy rollback-rev2-control 18907
      install -m 700 /tmp/prod-deploy-t3.rev2.sh "$ROOT/rollback-rev2-control/prod-deploy-t3.rev2.sh"
      invoke_from_prod rollback-rev2-control "$ROOT/rollback-rev2-control/prod-deploy-t3.rev2.sh" rollback "$R"
      wait_result_change 40
      report rollback-rev2-control 18907; echo "-- invoker (inside fake prod):"; sed 's/^/  /' "$ROOT/rollback-rev2-control/invoker.log"
      check "control: revision 2's rollback was killed with prod" "$(result_of) | $(active_of jess-fake-prod-$c)" "installed * | inactive"
      check "control: invoker never finished" "$(grep -c 'invoker finished' "$ROOT/$c/invoker.log" || true)" "0" ;;
    *) echo "unknown case $1" >&2; FAILS=$((FAILS + 1)); FAILED_CHECKS+=("$1: unknown case") ;;
  esac
  echo
}
CASES=("$@"); ((${#CASES[@]})) || CASES=(happy identity-changed backup-fails migration-missing accept-stopped hanging-listener rollback-unhealthy restore-stop-fails rollback-own-unit rollback-rev2-control)
for c in "${CASES[@]}"; do run_case "$c"; done
for c in "${CASES[@]}"; do teardown "$c"; done
echo "fake units removed; sandbox kept in $ROOT for inspection"
if ((FAILS)); then printf 'FAILED: %s check(s)\n' "$FAILS"; printf '  %s\n' "${FAILED_CHECKS[@]}"; exit 1; fi
echo "PASSED: all checks"
