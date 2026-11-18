#!/usr/bin/env bash
# Offline tests for the shell logic of build.sh and lock.sh: the worktree overlay of `stage`, the
# environment cleaning of `dc`, and the lock owner's start time. No Docker daemon, no network: a
# scratch git repository under TMPDIR (the real repository is never touched) and a fake `docker`.
# Run by `gate.sh olc` (selftest). Exit 0 all pass, 1 a case failed (each failure is printed).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dozo-buildtest-XXXXXX")" || exit 1
BG=""
trap '[ -z "$BG" ] || { kill "$BG"; wait "$BG"; } 2>/dev/null; rm -rf "$TMP"' EXIT
FAILED=0
bad() { FAILED=1; echo "[build.test] FAIL: $*"; }

# ---- stage overlay: DOZO_STAGE_REF older than HEAD, plus uncommitted and untracked changes ----
R="$TMP/repo"
mkdir -p "$R/dozo/docker" "$R/infra/compose"
cp "$HERE/build.sh" "$HERE/lock.sh" "$R/dozo/docker/"
g() { git -C "$R" -c user.name=t -c user.email=t@example.invalid -c core.autocrlf=false "$@"; }
mk() { mkdir -p "$(dirname "$R/$1")"; printf '%s\n' "${2:-$1}" > "$R/$1"; }

g init -q
echo ignored.log > "$R/.gitignore"
echo "x" > "$R/infra/compose/docker-compose.yml"; echo notice > "$R/dozo/NOTICE"; echo licence > "$R/dozo/LICENSE"; echo make > "$R/Makefile"
mk ftd; mk dtf/x; mk dtf/y/z; mk "old name.txt"; mk "ünï/ça va.txt"; mk gone.txt; mk keep.txt; mk reg
mk keepdir/k; mk "tab	name.txt"; mk modeless; mk unchanged.txt
ln -s keep.txt "$R/ln"; ln -s keepdir "$R/sl"; ln -s missing "$R/dang"
g add -A; g commit -qm A
REF="$(g rev-parse HEAD)"
# Committed after the ref: file to directory, a rename, a changed Unicode name.
g rm -q ftd; mk ftd/in.txt; g mv "old name.txt" "new name.txt"; mk "ünï/ça va.txt" changed
g add -A; g commit -qm B
# Uncommitted: directory to file, a deleted file and dangling link, a link and a file swapping
# type, a link to a directory becoming a real directory, a new untracked file with an odd name,
# and a file git ignores.
rm -r "$R/dtf"; mk dtf "now a file"
rm "$R/gone.txt" "$R/dang"
rm "$R/ln"; mk ln "now a file"
rm "$R/reg"; ln -s keep.txt "$R/reg"
rm "$R/sl"; mk sl/f
chmod +x "$R/modeless"
mk "new/untracked ✓.txt"; mk ignored.log

# What the stage must hold: every tracked or untracked, not ignored path that exists, minus what
# stage drops on purpose (the Makefile, dozo/ except NOTICE and LICENSE) and plus the .dockerignore it writes.
sig() { # root; NUL-separated relative paths on stdin
  local p; while IFS= read -r -d '' p; do
    if [ -L "$1/$p" ]; then echo "L $p -> $(readlink "$1/$p")"
    elif [ -f "$1/$p" ]; then echo "F $p $(cksum < "$1/$p") $([ -x "$1/$p" ] && echo x)"; fi
  done | LC_ALL=C sort
}
kept() { local p; while IFS= read -r -d '' p; do
  case "$p" in Makefile | dozo/docker/*) ;; *) printf '%s\0' "$p" ;; esac
done; }
want="$(g ls-files -z -c -o --exclude-standard | kept | sig "$R" | grep -v ' \.dockerignore ')"
stripdot() { local p; while IFS= read -r -d '' p; do printf '%s\0' "${p#./}"; done; }
STG="$TMP/stage"
out="$(cd "$R" && DOZO_STAGE_DIR="$STG" DOZO_STAGE_REF="$REF" DOZO_STAGE_WORKTREE=1 dozo/docker/build.sh stage 2>&1)" \
  || bad "stage with DOZO_STAGE_REF exited non-zero: $out"
got="$(cd "$STG/src" && find . -path ./data -prune -o \( -type f -o -type l \) -print0 | stripdot | sig "$STG/src" | grep -v ' \.dockerignore ')"
if [ "$got" != "$want" ]; then
  bad "stage differs from the working tree (< want, > got):"
  diff <(echo "$want") <(echo "$got") | sed 's/^/[build.test]   /'
fi
# Nothing may land outside the stage: a symlink in the old tree must not be written through.
[ -f "$R/keepdir/k" ] && [ "$(cat "$R/keepdir/k")" = keepdir/k ] || bad "a file outside the stage was changed through a symlink"

# ---- dc: every key of the env file is removed from the environment, whatever else the file holds ----
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/docker" <<'EOF'
#!/bin/sh
[ "$1 $2 $3" = "compose version --short" ] && { echo 2.30.0; exit 0; }
printf 'A=%s B=%s C=%s D=%s\n' "${SECRET_A-unset}" "${SECRET_B-unset}" "${SECRET_C-unset}" "${SECRET_D-unset}" > "$FAKE_OUT"
EOF
chmod +x "$BIN/docker"
mkdir -p "$STG/src/infra/compose"; : > "$STG/src/infra/compose/docker-compose.yml"
# A comment, a blank line, a line of spaces, a commented-out key, an indented key and `export`.
printf '%s\n' '# a hand-written comment' '' '   ' '# SECRET_D=commented out' 'SECRET_A=1' '  SECRET_B=2' 'export SECRET_C=3' > "$STG/dozo.env"
if out="$(cd "$R" && PATH="$BIN:$PATH" FAKE_OUT="$TMP/fake.out" SECRET_A=x SECRET_B=x SECRET_C=x SECRET_D=x \
    DOZO_STAGE_DIR="$STG" dozo/docker/build.sh down 2>&1)"; then
  [ "$(cat "$TMP/fake.out" 2>/dev/null)" = "A=unset B=unset C=unset D=x" ] \
    || bad "dc left a key of the env file in the environment (want A,B,C unset and the commented D kept): $(cat "$TMP/fake.out" 2>/dev/null)"
else bad "down failed with a comment or a blank line in the env file: $out"; fi

# ---- lock: the owner's start time must not depend on the viewer's TZ or locale ----
TZ=Asia/Tokyo LC_ALL=C bash -c '. "$1"; echo "$LOCK_ME"; exec sleep 30' _ "$HERE/lock.sh" > "$TMP/owner" & BG=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$TMP/owner" ] && break; sleep 0.1; done
owner="$(cat "$TMP/owner")"
if ! TZ=UTC LC_ALL=C bash -c '. "$1"; lock_owner_alive "$2"' _ "$HERE/lock.sh" "$owner"; then
  bad "a live lock owner ('$owner') is taken for dead when the viewer's TZ differs"
fi
if TZ=UTC LC_ALL=C bash -c '. "$1"; lock_owner_alive "$2"' _ "$HERE/lock.sh" "$BG Mon Jan  1 00:00:00 2001"; then
  bad "a live pid with another start time is taken for the owner (a reused pid)"
fi

# ---- unit: fewer fork test files than the committed tree has is a failure, found before Docker ----
U="$TMP/unit-src"; mkdir -p "$U/apps/web" "$U/packages/x"
for n in 1 2 3 4; do : > "$U/apps/web/dozo-t$n.test.ts"; done
out="$(cd "$REPO" && DOZO_UNIT_SRC="$U" "$HERE/gate.sh" unit 2>&1)"; rc=$?
{ [ "$rc" = 2 ] && printf '%s' "$out" | grep -q 'the committed tree has [0-9]* (a deleted test'; } \
  || bad "four fork test files against a committed tree with more did not fail the unit step (exit $rc): $(printf '%s' "$out" | tail -3)"

[ "$FAILED" = 0 ] && echo "[build.test] ok: stage overlay, dc env cleaning, lock owner start time, fork test count"
exit "$FAILED"
