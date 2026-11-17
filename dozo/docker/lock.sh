#!/usr/bin/env bash
# Sourced by build.sh and gate.sh: one run at a time on a stage area. The lock is the directory
# <stage>/.lock (mkdir is atomic) holding the owner's pid. A dead owner's lock (SIGKILL, power loss) is
# taken over: the directory is renamed away first, which only one taker can do. `gate.sh qa` holds the
# lock for the whole run and exports its pid as DOZO_LOCK_OWNER, so the build.sh steps it starts are
# not a second run. Prints the reason and returns 1 when a live run holds it.
STAGE_LOCK_MINE=""
stage_lock() { # stage-dir
  local dir="$1/.lock" pid
  mkdir -p "$1" || return 1
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  [ -z "${DOZO_LOCK_OWNER:-}" ] || [ "$pid" != "$DOZO_LOCK_OWNER" ] || ! kill -0 "$pid" 2>/dev/null || return 0
  until mkdir "$dir" 2>/dev/null; do
    pid="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "[dozo] lock: taking over the lock of a dead run (pid $pid)" >&2
      mv "$dir" "$dir.dead.$$" 2>/dev/null && rm -rf "$dir.dead.$$"
    else
      echo "[dozo] another run holds $dir (pid ${pid:-unknown}); wait for it, or stop it. If it is gone and the lock stays, remove that directory" >&2
      return 1
    fi
  done
  echo "$$" > "$dir/pid"; STAGE_LOCK_MINE="$dir"
}
stage_unlock() { [ -z "$STAGE_LOCK_MINE" ] || rm -rf "$STAGE_LOCK_MINE"; STAGE_LOCK_MINE=""; }
