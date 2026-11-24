#!/usr/bin/env bash
# One deploy at a time per host: a lock kept ON the host, so deploys started from different
# machines see each other (a local lock file or flock would not, and macOS has no flock).
# Sourced by deploy.sh; needs say, die, `remote` (ssh to the host, arguments joined and parsed by
# the host's shell) and $remote_dir. Tested offline with `remote` pointed at the local shell:
# dozo/deploy/deploy-lock.test.sh. Settings and behaviour: dozo/deploy/README.md, Deploy lock.
#
# The lock is a symbolic link, not a directory: `ln -s` is atomic like `mkdir` and its target
# holds "<run id>:<label>:<start time>" in the same step, so no moment exists in which the lock is
# held but unreadable (a run killed between mkdir and the write would block for the stale limit).
# The id is random and the label is the action and commit; neither names a person or machine.

lock_id=""

# The host side. $1 take|release, $2 lock path, $3 run id, $4 label, $5 stale limit in seconds.
# take: exit 0 taken (also when this id already holds it: a reply lost to a dropped connection
# is retried), 3 held (prints "<seconds held> <label>", or "unreadable -" when the target is not
# "<id>:<label>:<digits>"; such a lock is never broken), 4 could not tell.
# A stale lock is broken under a second link, "<path>.break", that only one run can hold: the
# lock is re-read under it and removed only if it is still the same stale value.
lock_host_script() {
  cat <<'HOST'
mode=$1 path=$2 id=$3 label=$4 stale=$5
now=$(date +%s)
brk="$path.break"
case $mode in
  take)
    mkdir -p "$(dirname "$path")" || exit 4
    for _ in 1 2 3 4 5; do
      ln -s "$id:$label:$now" "$path" 2>/dev/null && exit 0
      cur=$(readlink "$path" 2>/dev/null) || continue
      case $cur in "$id":*) exit 0 ;; esac
      ts=${cur##*:} held=${cur%:*} hlabel=${held#*:}
      case $ts in '' | *[!0-9]*) printf 'unreadable -\n'; exit 3 ;; esac
      case $held in *:*) ;; *) printf 'unreadable -\n'; exit 3 ;; esac
      age=$((now - ts))
      [ "$age" -gt "$stale" ] || { printf '%s %s\n' "$age" "$hlabel"; exit 3; }
      if ! ln -s "$id:$now" "$brk" 2>/dev/null; then
        # Someone else is breaking. A break link left behind for over a minute is removed.
        b=$(readlink "$brk" 2>/dev/null) || continue
        bts=${b##*:}
        case $bts in '' | *[!0-9]*) bts=0 ;; esac
        [ $((now - bts)) -gt 60 ] && rm -f "$brk"
        printf '%s %s\n' "$age" "$hlabel"
        exit 3
      fi
      if [ "$(readlink "$path" 2>/dev/null)" = "$cur" ]; then
        printf '[deploy] breaking a lock held for %ss by %s\n' "$age" "$hlabel" >&2
        rm -f "$path"
      fi
      rm -f "$brk"
    done
    exit 4
    ;;
  release)
    cur=$(readlink "$path" 2>/dev/null) || exit 0
    case $cur in "$id":*) rm -f "$path" ;; esac
    ;;
esac
HOST
}

lock_path() { printf '%s/.deploy.lock' "$remote_dir"; }

# lock_call <mode> <label> <stale>: one ssh to the host (the script comes on stdin), tried again up
# to 3 times when ssh itself fails (255). The reply is in $lock_out; the return value is the
# script's. `lock_id` is the run's own id, so a take that went through but whose reply was lost
# finds itself holding on the retry.
lock_out=""
lock_call() {
  local try rc script
  script=$(lock_host_script)
  for try in 1 2 3 4; do
    rc=0
    lock_out=$(remote bash -s -- "$1" "$(lock_path)" "$lock_id" "$2" "$3" <<<"$script") || rc=$?
    [ "$rc" -eq 255 ] || return "$rc"
    if [ "$try" -lt 4 ]; then
      sleep "${DOZO_DEPLOY_LOCK_POLL:-5}" &
      wait $! || true
    fi
  done
  return 255
}

# lock_take <label>: wait up to DOZO_DEPLOY_LOCK_WAIT seconds (default 1800, 0 = fail at once) for
# the host's lock, one short ssh per poll (DOZO_DEPLOY_LOCK_POLL, default 5). A lock older than
# DOZO_DEPLOY_LOCK_STALE seconds (default 7200) is broken. A bad value exits 64 before any ssh.
lock_take() {
  local label wait stale start rc age what name announced=""
  wait=${DOZO_DEPLOY_LOCK_WAIT:-1800} stale=${DOZO_DEPLOY_LOCK_STALE:-7200}
  for name in WAIT STALE; do
    case $name in WAIT) what=$wait ;; *) what=$stale ;; esac
    case $what in '' | *[!0-9]*)
      printf '[deploy] FAIL: DOZO_DEPLOY_LOCK_%s must be a whole number of seconds, got "%s"\n' "$name" "$what" >&2
      exit 64 ;;
    esac
  done
  label=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' _)
  # Random, not $RANDOM alone: bash 3.2 seeds it from the clock and pid, so runs started in the same
  # second can draw the same id, and an id that is already holding counts as taken.
  lock_id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n') || lock_id=""
  [ -n "$lock_id" ] || lock_id=$(printf '%x%x%x%x' "$$" "$RANDOM" "$RANDOM" "$(date +%s)")
  start=$(date +%s)
  while :; do
    rc=0
    lock_call take "$label" "$stale" || rc=$?
    case $rc in
      0) return 0 ;;
      3) ;;
      *) die "could not take the deploy lock on the host (ssh or shell failed)" ;;
    esac
    age=${lock_out%% *}
    if [ "$age" = unreadable ]; then
      what="the lock on the host cannot be read; if no deploy is running, remove it: ssh <host> rm $(lock_path)"
    else
      what="a deploy is running on the host (${lock_out#* }, started ${age}s ago)"
    fi
    if [ "$(($(date +%s) - start))" -ge "$wait" ]; then
      lock_id=""
      die "$what; waited ${wait}s. Try again when it ends, or set DOZO_DEPLOY_LOCK_WAIT"
    fi
    [ -n "$announced" ] || say "$what; waiting up to ${wait}s"
    announced=1
    # In the background and waited for, so a signal runs the traps at once instead of after the sleep.
    sleep "${DOZO_DEPLOY_LOCK_POLL:-5}" &
    wait $! || true
  done
}

# Frees the lock only when this run holds it: a run whose stale lock was broken must not remove
# the next run's. Safe to call twice. A signal needs no handler here: bash runs the EXIT trap
# that calls this when it is ended by an untrapped TERM, INT or HUP, at once, even while a
# foreground command runs (checked on bash 3.2 and 5).
lock_release() {
  [ -n "$lock_id" ] || return 0
  local rc=0
  lock_call release x 0 || rc=$?
  lock_id=""
  [ "$rc" -eq 0 ] || say "could not release the deploy lock; it expires after ${DOZO_DEPLOY_LOCK_STALE:-7200}s"
  return 0
}
