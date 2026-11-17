#!/usr/bin/env bash
# Sourced by build.sh, gate.sh and e2e/run.sh: one run at a time on a shared directory (the stage
# area, the e2e output). The lock is a directory made with mkdir (atomic) that holds `owner`, the
# owner's pid and start time, so a reused pid is not taken for the owner. A stale lock is taken over
# under a second mkdir mutex named for the dead owner: one racer wins, and it checks under the mutex
# that the lock is still the one it saw (owner text and inode), so it can never remove a lock another
# run made meanwhile. A lock without an owner file is one being made: it is given 2 s, then its maker
# is taken for dead. `gate.sh qa` holds the stage lock for all its steps and exports its pid as
# DOZO_LOCK_OWNER, so the build.sh steps it starts are not a second run.
# The start time as ps prints it depends on TZ and the locale: fixed here, so the owner who wrote it
# and the run that checks it (another shell, another TZ) read the same text. `|| true`: a ps that
# fails (a sandbox) gives an empty time, never an exit under `set -e -o pipefail`.
lock_start() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//' || true; }
LOCK_START="$(lock_start $$)"
LOCK_ME="$$ ${LOCK_START:--}"
LOCK_HELD=""

lock_owner_alive() { # $1 = "<pid> <start>" as written by the owner
  local pid="${1%% *}" start="${1#* }"
  kill -0 "$pid" 2>/dev/null && { [ "$start" = - ] || [ "$(lock_start "$pid")" = "$start" ]; }
}

# lock_acquire DIR WHAT TAG: 0 when taken; 1 with a message (prefixed TAG, naming WHAT) on stderr.
lock_acquire() {
  local dir="$1" what="$2" tag="$3" n seen ino key
  for n in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if mkdir "$dir" 2>/dev/null; then
      printf '%s\n' "$LOCK_ME" > "$dir/.owner" && mv "$dir/.owner" "$dir/owner" && { LOCK_HELD="$dir"; return 0; }
      echo "$tag cannot write the lock $dir" >&2; return 1
    fi
    [ -e "$dir" ] || continue
    [ -d "$dir" ] && [ -O "$dir" ] || { echo "$tag $dir is not a directory of this user; remove it or set TMPDIR" >&2; return 1; }
    seen="$(cat "$dir/owner" 2>/dev/null || true)"; ino="$(ls -di "$dir" 2>/dev/null | awk '{print $1}')"
    if [ -n "$seen" ] && lock_owner_alive "$seen"; then
      echo "$tag another $what is in progress (pid ${seen%% *}); wait for it to finish" >&2; return 1
    fi
    # No owner file yet: a lock being made. Give it 2 s; after that its maker died.
    if [ -z "$seen" ] && [ "$n" -lt 10 ]; then sleep 0.2; continue; fi
    key="$dir.takeover.${seen%% *}"
    if mkdir "$key" 2>/dev/null; then
      if [ "$(cat "$dir/owner" 2>/dev/null || true)" = "$seen" ] && [ "$(ls -di "$dir" 2>/dev/null | awk '{print $1}')" = "$ino" ]; then rm -rf "$dir"; fi
      rmdir "$key"
    else sleep 0.2
    fi
  done
  echo "$tag cannot take the lock $dir (another run is taking it over, or $dir.takeover.* is left over: remove it)" >&2; return 1
}

# Releases the lock taken here, and only if it is still ours.
lock_release() {
  [ -z "$LOCK_HELD" ] || [ "$(cat "$LOCK_HELD/owner" 2>/dev/null)" != "$LOCK_ME" ] || rm -rf "$LOCK_HELD"
  LOCK_HELD=""
}

# The stage area's lock; a live DOZO_LOCK_OWNER that holds it counts as ourselves.
stage_lock() { # stage-dir
  local owner
  mkdir -p "$1" || return 1
  owner="$(cat "$1/.lock/owner" 2>/dev/null || true)"
  [ -z "${DOZO_LOCK_OWNER:-}" ] || [ "${owner%% *}" != "$DOZO_LOCK_OWNER" ] || ! lock_owner_alive "$owner" || return 0
  lock_acquire "$1/.lock" "run on the stage area" "[dozo]"
}
stage_unlock() { lock_release; }
