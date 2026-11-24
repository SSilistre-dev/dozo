#!/usr/bin/env bash
# Offline checks of the deploy lock (deploy-lock.sh): `remote` runs the host's commands in the local
# shell, the way ssh hands them to the host's shell, and no ssh is started. Run by `gate.sh olc`.
# Usage: deploy-lock.test.sh. Exit 0 all pass, 1 a case failed (each is printed).
# Holders hold until a file appears and waits end on a condition, never on a sleep margin.
set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-lock.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dozo-lock-test.XXXXXX")
FAILED=0
bad() { FAILED=1; echo "[lock.test] FAIL: $*"; }
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT
LOCK="$WORK/dir/.deploy.lock"
BRK="$LOCK.break"

# The "deploy" process: the lock library with the options and helpers deploy.sh gives it. FLAKY_FILE holds a
# count: that many calls run on the "host" and then report ssh's 255 (the reply is lost);
# DEAD_SSH makes every call 255 without running anything; CALLS counts the calls.
cat >"$WORK/driver.sh" <<DRV
# The options and the ERR trap deploy.sh runs with: a status that escapes \`remote\` prints a line.
set -Eeuo pipefail
. "$LIB"
say() { printf '[deploy] %s\n' "\$*"; }
die() { printf '[deploy] FAIL: %s\n' "\$*" >&2; exit 2; }
trap 'die "line \$LINENO: \$BASH_COMMAND"' ERR
# Like deploy.sh's: a function whose last command is the transport and whose status is its own.
remote() {
  echo x >>"$WORK/calls"
  if [ -n "\${DEAD_SSH:-}" ]; then sh -c 'exit 255'; return; fi
  local n drop=""
  if [ -s "$WORK/flaky" ]; then
    n=\$(cat "$WORK/flaky")
    if [ "\$n" -gt 0 ]; then echo \$((n - 1)) >"$WORK/flaky"; drop=1; fi
  fi
  # The command runs on the host and the reply is lost.
  if [ -n "\$drop" ]; then sh -c "\$*" >/dev/null; sh -c 'exit 255'; return; fi
  sh -c "\$*"
}
remote_dir="$WORK/dir"
eval "\$1"
DRV
run() { env -u DOZO_DEPLOY_LOCK_WAIT -u DOZO_DEPLOY_LOCK_STALE DOZO_DEPLOY_LOCK_POLL=1 "${@:2}" bash "$WORK/driver.sh" "$1"; }
holder() { readlink "$LOCK" 2>/dev/null || echo none; }
reset() { rm -rf "$WORK/dir" "$WORK/go" "$WORK/calls" "$WORK/flaky"; mkdir -p "$WORK/dir"; : >"$WORK/flaky"; }
# await <file> <text>: until the file holds the text (20 s at most).
await() { local i; for i in $(seq 200); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
HOLD='while [ ! -e "'"$WORK"'/go" ]; do sleep 0.1; done'

# No expected case (held, waiting, unreadable, not the owner, ssh retried) prints the ERR trap's line.
noerr() { case $2 in *"FAIL: line"*) bad "$1: the ERR trap fired: $2" ;; esac; }

# A second taker does not get through while the first holds: with no wait it fails at once and says so.
reset
run 'trap lock_release EXIT; lock_take deploy-aaa; echo ready; '"$HOLD" >"$WORK/h.out" 2>&1 &
holder_pid=$!
await "$WORK/h.out" ready || bad "the first run did not take the lock"
out=$(run 'lock_take deploy-bbb' DOZO_DEPLOY_LOCK_WAIT=0 2>&1); rc=$?
[ "$rc" = 2 ] || bad "second taker with WAIT=0: want exit 2, got $rc"
case $out in *"a deploy is running"*deploy-aaa*) ;; *) bad "second taker: message does not say a deploy runs: $out" ;; esac
noerr held "$out"
case $(holder) in *:deploy-aaa:*) ;; *) bad "the failed taker changed the lock: $(holder)" ;; esac

# It waits (one waiting line) and takes over once the holder is told to release.
run 'trap lock_release EXIT; lock_take deploy-ccc; echo got-$lock_id' DOZO_DEPLOY_LOCK_WAIT=60 >"$WORK/w.out" 2>&1 &
waiter_pid=$!
await "$WORK/w.out" "waiting up to" || bad "waiting taker printed no waiting line"
touch "$WORK/go"
wait "$holder_pid" 2>/dev/null
wait "$waiter_pid"; rc=$?
[ "$rc" = 0 ] || bad "waiting taker: want exit 0, got $rc ($(cat "$WORK/w.out"))"
noerr waiting "$(cat "$WORK/w.out")"
grep -q 'got-' "$WORK/w.out" || bad "waiting taker never took the lock"
[ "$(grep -c 'waiting up to' "$WORK/w.out")" = 1 ] || bad "waiting line printed more than once"
[ "$(holder)" = none ] || bad "the waiter's exit left the lock: $(holder)"

# Stale: older than the limit is broken (default limit 7200); younger is not; the limit is settable.
reset
ln -s "deadbeef:deploy-old:$(($(date +%s) - 7201))" "$LOCK"
out=$(run 'lock_take deploy-new; echo "$lock_id" >"'"$WORK"'/id"' 2>&1); rc=$?
[ "$rc" = 0 ] || bad "stale lock: want it broken, got exit $rc ($out)"
case $out in *"breaking a lock held for"*deploy-old*) ;; *) bad "stale lock: no breaking line: $out" ;; esac
case $(holder) in "$(cat "$WORK/id")":deploy-new:*) ;; *) bad "stale lock: not held by the new run: $(holder)" ;; esac
[ ! -e "$BRK" ] && [ ! -L "$BRK" ] || bad "stale break left its break link"
reset
ln -s "deadbeef:deploy-old:$(($(date +%s) - 3700))" "$LOCK"
run 'lock_take deploy-new' DOZO_DEPLOY_LOCK_WAIT=0 >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && case $(holder) in deadbeef:*) ;; *) false ;; esac || bad "a lock of 3700s was broken with the default limit (exit $rc)"
run 'lock_take deploy-new' DOZO_DEPLOY_LOCK_WAIT=0 DOZO_DEPLOY_LOCK_STALE=100 >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] || bad "DOZO_DEPLOY_LOCK_STALE=100 did not break a 3700s lock (exit $rc)"

# Breakers are serialized: while another run holds the break link a stale lock stays; a break link
# left for over a minute is removed and the break goes through.
reset
ln -s "deadbeef:deploy-old:$(($(date +%s) - 9000))" "$LOCK"
ln -s "other:$(date +%s)" "$BRK"
run 'lock_take deploy-new' DOZO_DEPLOY_LOCK_WAIT=0 >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && case $(holder) in deadbeef:*) ;; *) false ;; esac || bad "broke a stale lock while another run held the break link (exit $rc)"
rm -f "$BRK"; ln -s "other:$(($(date +%s) - 120))" "$BRK"
run 'lock_take deploy-new' DOZO_DEPLOY_LOCK_WAIT=30 >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] || bad "a break link over a minute old blocked the break (exit $rc)"
# Four takers on one stale lock: never two inside at once.
reset
ln -s "deadbeef:deploy-old:$(($(date +%s) - 9000))" "$LOCK"
: >"$WORK/trace"
for n in 1 2 3 4; do
  run 'trap lock_release EXIT; lock_take deploy-r'"$n"'; echo in >>"'"$WORK"'/trace"; sleep 0.3; echo out >>"'"$WORK"'/trace"' DOZO_DEPLOY_LOCK_WAIT=60 >/dev/null 2>&1 &
done
wait $(jobs -p) 2>/dev/null
[ "$(tr -d '\n' <"$WORK/trace")" = "inoutinoutinoutinout" ] || bad "takers overlapped or one never got in: $(tr '\n' ' ' <"$WORK/trace")"
[ "$(holder)" = none ] || bad "the takers left the lock: $(holder)"

# An unreadable lock is never broken, however old; the message says how to remove it.
reset
ln -s "garbage" "$LOCK"
out=$(run 'lock_take deploy-new' DOZO_DEPLOY_LOCK_WAIT=0 DOZO_DEPLOY_LOCK_STALE=0 2>&1); rc=$?
[ "$rc" = 2 ] && [ "$(holder)" = garbage ] || bad "an unreadable lock was broken or taken (exit $rc)"
noerr unreadable "$out"
case $out in *"cannot be read"*"rm "*) ;; *) bad "unreadable lock: message lacks the removal hint: $out" ;; esac

# Release frees the lock; a run that does not hold it leaves the lock alone.
reset
run 'lock_take deploy-one; lock_release' >/dev/null 2>&1
[ "$(holder)" = none ] || bad "release did not free the lock: $(holder)"
reset
ln -s "cafe:deploy-other:$(date +%s)" "$LOCK"
out=$(run 'lock_id=notmine; lock_release; echo survived' 2>&1)
noerr non-owner "$out"
case $out in *survived*) ;; *) bad "non-owner release did not end cleanly: $out" ;; esac
case $(holder) in cafe:deploy-other:*) ;; *) bad "a non-owner release removed the lock: $(holder)" ;; esac
run 'lock_release' >/dev/null 2>&1
case $(holder) in cafe:*) ;; *) bad "a run that never took the lock removed it" ;; esac

# ssh failing (255) is tried again; a take whose reply was lost finds itself holding, not held.
reset
echo 1 >"$WORK/flaky"
out=$(run 'lock_take deploy-flaky; lock_release' 2>&1); rc=$?
noerr "lost reply" "$out"
[ "$rc" = 0 ] || bad "take with a lost reply: want exit 0, got $rc"
[ "$(wc -l <"$WORK/calls" | tr -d ' ')" = 3 ] || bad "take with a lost reply: want 3 calls (take, take again, release), got $(wc -l <"$WORK/calls")"
[ "$(holder)" = none ] || bad "take with a lost reply: the release left the lock: $(holder)"
reset
echo 1 >"$WORK/flaky"
run 'lock_take deploy-held-then-lost; echo kept' >"$WORK/f.out" 2>&1
grep -q kept "$WORK/f.out" && case $(holder) in *:deploy-held-then-lost:*) ;; *) false ;; esac || bad "take with a lost reply did not end holding"
reset
out=$(run 'lock_take deploy-dead' DEAD_SSH=1 2>&1); rc=$?
noerr "dead ssh" "$out"
[ "$rc" = 2 ] && [ "$(wc -l <"$WORK/calls" | tr -d ' ')" = 4 ] || bad "dead ssh: want exit 2 after 4 tries, got $rc after $(wc -l <"$WORK/calls") ($out)"

# A bad wait or stale value exits 64 before any ssh.
for v in WAIT STALE; do
  for val in abc -5 1.5; do
    reset
    run 'lock_take deploy-x' "DOZO_DEPLOY_LOCK_$v=$val" >/dev/null 2>&1; rc=$?
    [ "$rc" = 64 ] && [ ! -e "$WORK/calls" ] || bad "DOZO_DEPLOY_LOCK_$v='$val': want exit 64 and no ssh, got $rc"
  done
done

# A run ended by an untrapped signal releases through its EXIT trap, at once, whether it waits on a
# foreground command or on a background one (deploy.sh sets no signal trap; checked on bash 3.2 and 5).
# INT is left out: a background job ignores it, and a terminal sends it to the foreground group.
# Started directly, not through `run`, so that the pid killed is the run's own shell.
for case_ in 'TERM fg' 'HUP fg' 'TERM bg'; do
  set -- $case_
  reset
  : >"$WORK/ready"
  if [ "$2" = fg ]; then body="$HOLD"; else body='sleep 20 & wait $!'; fi
  bash "$WORK/driver.sh" 'trap lock_release EXIT; lock_take deploy-kill; echo ready; '"$body" >"$WORK/ready" 2>&1 &
  kill_pid=$!
  await "$WORK/ready" ready || bad "$case_: the run did not take the lock"
  kill -"$1" "$kill_pid" 2>/dev/null
  wait "$kill_pid" 2>/dev/null
  [ "$(holder)" = none ] || bad "$case_: a signalled run left the lock: $(holder)"
done

[ "$FAILED" = 0 ] && echo "[lock.test] ok: held, wait, stale, break race, unreadable, release, ssh retry, bad values, signal"
exit "$FAILED"
