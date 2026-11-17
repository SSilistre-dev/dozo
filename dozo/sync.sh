#!/usr/bin/env bash
# Pull upstream (Rakazo) into a review branch of the Dozo fork. Never pushes, never touches main.
# See dozo/SYNC.md. Exit codes: 0 ok / up to date; 1 error (usage, missing remote or branch, dirty
# tree, merge failed without a conflict); 2 refused (non-fast-forward upstream-main, a dozo-* file
# shipped by upstream), predicted or real merge conflict, or a failed gate; 129/130/143 on a signal.
# The full table is in dozo/SYNC.md.
set -euo pipefail

UP_REMOTE=upstream
UP_BRANCH=upstream-main
MAIN=main
DRY=0
FAST=0

usage() {
  cat <<'EOF'
Usage: dozo/sync.sh [--dry-run] [--fast] [--help]

Fetches upstream/main, fast-forwards the pristine upstream-main branch, creates
sync/upstream-<short-sha> from main and merges upstream-main into it (merge commit,
never rebase). Then runs `make qa` (its first step is `make olc`). With a Makefile, a
missing `make` or target is a failure (exit 2).

  --dry-run  fetch and report what would be merged and predicted conflicts
             (git merge-tree). Changes no branch, index or file; the fetch updates
             the remote-tracking ref refs/remotes/upstream/main.
  --fast     run only `make olc`, skip `make qa`
  --help     this text

Never pushes. The maintainer reviews the sync branch and merges it into main.
Exit 2: upstream-main is not a fast-forward, the merge conflicts (also predicted, with
--dry-run), or a gate fails. Exit 1: any other error. See dozo/SYNC.md.
EOF
}

for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --fast) FAST=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown flag: $a" >&2; usage >&2; exit 1 ;;
  esac
done

say() { echo "[sync] $*"; }
die() { echo "[sync] ERROR: $1" >&2; exit "${2:-1}"; }

# `cd ""` succeeds silently, so a failed rev-parse must stop here.
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository (run dozo/sync.sh from the Dozo checkout)"
cd "$TOP"
GATE="$TOP/dozo/docker/gate.sh"

git remote get-url "$UP_REMOTE" >/dev/null 2>&1 || die "remote '$UP_REMOTE' not found. Add it: git remote add upstream https://github.com/elie222/rakazo.git"
git rev-parse --verify -q "refs/heads/$MAIN" >/dev/null || die "branch '$MAIN' not found"

if [ "$DRY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "working tree is not clean; commit or stash first (--dry-run does not need a clean tree)"
fi

say "fetching $UP_REMOTE main"
# No curl here: the only network call is this fetch. Give up on a link slower than 1 kB/s for 60 s
# instead of hanging (applies to http(s) remotes; ssh remotes use their own keepalive).
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --quiet "$UP_REMOTE" main
NEW_SHA=$(git rev-parse "refs/remotes/$UP_REMOTE/main")
SHORT=$(git rev-parse --short=9 "$NEW_SHA")

# upstream-main must stay pristine: only ever fast-forwarded.
if git rev-parse --verify -q "refs/heads/$UP_BRANCH" >/dev/null; then
  OLD_UP=$(git rev-parse "refs/heads/$UP_BRANCH")
  if ! git merge-base --is-ancestor "$OLD_UP" "$NEW_SHA"; then
    die "$UP_BRANCH ($OLD_UP) is not an ancestor of $UP_REMOTE/main ($NEW_SHA): upstream rewrote history or $UP_BRANCH is no longer pristine. Refusing; fix by hand." 2
  fi
else
  die "branch '$UP_BRANCH' not found; create it from the pristine upstream: git branch $UP_BRANCH $UP_REMOTE/main"
fi

# Range = last upstream commit already merged into main .. new upstream tip.
BASE=$(git merge-base "$MAIN" "$NEW_SHA" || true)
[ -n "$BASE" ] || die "main and upstream share no history"

COMMITS=$(git rev-list --count "$MAIN..$NEW_SHA")
FILES=$(git diff --name-only "$BASE" "$NEW_SHA" | wc -l | tr -d ' ')
RANGE="$(git rev-parse --short=9 "$BASE")..$SHORT"

fork_files() { git ls-tree -r --name-only "$1" -- apps packages | grep '/dozo-[^/]*$' || true; }  # $1 = tree-ish

# Upstream must never ship a dozo-* file of its own: it would overwrite or conflict with ours.
CLASH=$(fork_files "$NEW_SHA")
[ -z "$CLASH" ] || die "upstream ships dozo-* file(s) that clash with the fork's own naming; rename ours first: $(printf '%s' "$CLASH" | tr '\n' ' ')" 2

# The same computation as `make olc` (gate.sh upstream-edits): upstream's files that our result
# edited, deleted or retyped, compared with the upstream commit $2 that the result contains.
health() { # $1 = tree-ish holding our result, $2 = upstream commit to compare with
  HEALTH_FILES=$("$GATE" upstream-edits "$2" "$1") || die "cannot compute the fork health (gate.sh upstream-edits failed)"
  HEALTH=$([ -n "$HEALTH_FILES" ] && printf '%s\n' "$HEALTH_FILES" | wc -l | tr -d ' ' || echo 0)
}

# Moves the pristine upstream-main to the fetched tip. On that very branch update-ref would leave
# index and worktree behind (a dirty-looking tree), so fast-forward it with merge instead.
ff_upstream() {
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "$UP_BRANCH" ]; then git merge --ff-only --quiet "$NEW_SHA"
  else git update-ref -m "dozo/sync: ff $UP_BRANCH" "refs/heads/$UP_BRANCH" "$NEW_SHA" "$OLD_UP"; fi
}

report() { # $1 = tree-ish of the merge result, $2 = upstream ref
  health "$1" "$2"
  say "range merged:        $RANGE"
  say "upstream commits:    $COMMITS"
  say "files changed:       $FILES"
  say "fork files:          $(fork_files "$1" | grep -c . || true) dozo-* file(s) inside apps/ and packages/, kept as ours"
  say "fork health:         $HEALTH upstream-tracked file(s) differ from upstream outside our paths"
  if [ "$HEALTH" -gt 0 ]; then
    echo "[sync] WARNING: fork health above 0. Someone edited upstream files; these will conflict later:" >&2
    printf '%s\n' "$HEALTH_FILES" | sed 's/^/[sync]   /' >&2
  fi
}

if git merge-base --is-ancestor "$NEW_SHA" "$MAIN"; then
  say "main already contains upstream $SHORT; nothing to merge"
  [ "$DRY" = 1 ] || { [ "$OLD_UP" = "$NEW_SHA" ] || ff_upstream; }
  COMMITS=0; FILES=0; RANGE="$SHORT..$SHORT"
  report "$MAIN" "$NEW_SHA"
  exit 0
fi

CONFLICT_RULE="conflicts are only expected in files we own; if an upstream file conflicts it means someone committed an edit to it, see dozo/SYNC.md"

if [ "$DRY" = 1 ]; then
  say "dry run: nothing will be changed"
  if [ "$OLD_UP" = "$NEW_SHA" ]; then say "$UP_BRANCH already at $SHORT"; else say "$UP_BRANCH would fast-forward $(git rev-parse --short=9 "$OLD_UP")..$SHORT"; fi
  say "would create branch sync/upstream-$SHORT from $MAIN"
  set +e
  OUT=$(git merge-tree --write-tree --name-only --no-messages "$MAIN" "$NEW_SHA" 2>&1)
  RC=$?
  set -e
  TREE=$(printf '%s\n' "$OUT" | head -1)
  if [ "$RC" -eq 0 ]; then
    say "predicted merge:     clean"
  elif [ "$RC" -eq 1 ]; then
    say "predicted merge:     CONFLICTS in:"
    printf '%s\n' "$OUT" | tail -n +2 | sed '/^$/,$d' | sed 's/^/[sync]   /'
    say "rule: $CONFLICT_RULE"
  else
    die "git merge-tree failed (exit $RC): $OUT"
  fi
  report "$TREE" "$NEW_SHA"
  [ "$RC" -eq 0 ] || exit 2
  exit 0
fi

# --- real run ---
ORIG=$(git rev-parse --abbrev-ref HEAD)
ORIG_SW=("$ORIG"); [ "$ORIG" != HEAD ] || ORIG_SW=(--detach "$(git rev-parse HEAD)")  # detached HEAD (CI)
BR="sync/upstream-$SHORT"
git rev-parse --verify -q "refs/heads/$BR" >/dev/null && die "branch $BR already exists; delete it or merge it first"

if [ "$OLD_UP" != "$NEW_SHA" ]; then
  ff_upstream
  say "$UP_BRANCH fast-forwarded to $SHORT"
fi

# From here until the merge commit exists, any unexpected exit (set -e, INT, TERM, HUP) puts us back
# on the original branch and removes the half-made sync branch. The conflict and failed-merge paths
# below already do that themselves; the trap is then a no-op because $BR is gone. SIGKILL cannot be
# trapped. Cleared once the merge is clean: a gate failure keeps $BR for inspection by design.
SYNC_PENDING=1
MERGE_LOG=""
cleanup_sync() {
  local rc=$?
  trap - EXIT INT TERM HUP
  [ -z "$MERGE_LOG" ] || rm -f "$MERGE_LOG"
  if [ "$SYNC_PENDING" = 1 ] && git rev-parse --verify -q "refs/heads/$BR" >/dev/null; then
    if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$BR" ]; then
      git merge --abort 2>/dev/null || git reset -q --hard 2>/dev/null || true
    fi
    git switch --quiet "${ORIG_SW[@]}" 2>/dev/null || true
    git branch -q -D "$BR" 2>/dev/null || true
    echo "[sync] stopped early (exit $rc): back on $ORIG, $BR removed" >&2
  fi
  exit "$rc"
}
trap cleanup_sync EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
git switch --quiet -c "$BR" "$MAIN"
say "created $BR from $MAIN; merging $UP_BRANCH"
# Keep git's own words (a conflict is reported on stdout, other failures on stderr) and decide by
# the index, not by the exit code: only unmerged paths make it a conflict.
MERGE_LOG=$(mktemp "${TMPDIR:-/tmp}/dozo-sync-merge-XXXXXX")
if ! git merge --no-ff --no-edit -m "Merge upstream $UP_REMOTE/main ($RANGE) into Dozo" "$UP_BRANCH" >"$MERGE_LOG" 2>&1; then
  CONFLICTED=$(git diff --name-only --diff-filter=U)
  git merge --abort 2>/dev/null || true
  git switch --quiet "${ORIG_SW[@]}"
  git branch -q -D "$BR"
  sed 's/^/[sync] git: /' "$MERGE_LOG" >&2; rm -f "$MERGE_LOG"
  if [ -n "$CONFLICTED" ]; then
    echo "[sync] MERGE CONFLICT in:" >&2
    printf '%s\n' "$CONFLICTED" | sed 's/^/[sync]   /' >&2
    echo "[sync] rule: $CONFLICT_RULE" >&2
    echo "[sync] merge aborted, $BR removed, back on $ORIG. $UP_BRANCH stays at $SHORT." >&2
    exit 2
  fi
  echo "[sync] MERGE FAILED without conflicts (git's message above); $BR removed, back on $ORIG. $UP_BRANCH stays at $SHORT." >&2
  exit 1
fi
rm -f "$MERGE_LOG"
SYNC_PENDING=0
say "merge clean on $BR"

# Gates. With a Makefile, `make` and the target must exist: a gate that cannot run is a failure,
# never a skip. Only a tree without any Makefile has no gates to run (a notice).
GATE_FAIL=0
run_gate() { # $1 = make target
  local out
  if [ ! -f Makefile ]; then say "NOTICE: no Makefile, make $1 skipped"; return 0; fi
  if ! command -v make >/dev/null 2>&1; then
    echo "[sync] ERROR: Makefile exists but make is not installed; cannot run make $1" >&2; GATE_FAIL=1; return 0
  fi
  if ! out=$(LC_ALL=C make -n "$1" 2>&1); then
    echo "[sync] ERROR: make target '$1' is missing or the Makefile is broken (make -n $1 failed):" >&2
    printf '%s\n' "$out" | head -n 5 | sed 's/^/[sync]   /' >&2
    GATE_FAIL=1; return 0
  fi
  say "running make $1"
  # Without the variables that make a run partial or weaker: a "QA: PASS (partial: ...)" must not
  # count here.
  env -u DOZO_QA_STEPS -u DOZO_SKIP_BRAND -u DOZO_UPSTREAM_REF -u DOZO_STAGE_REF -u DOZO_UNIT_SRC \
    -u DOZO_COVERAGE_MIN -u DOZO_BRAND_COVERAGE_MIN -u DOZO_MIN_FORK_TESTS make "$1" || { echo "[sync] make $1 FAILED" >&2; GATE_FAIL=1; }
}
# make qa starts with olc, so --fast runs olc alone and the full run runs qa alone.
if [ "$FAST" = 1 ]; then run_gate olc; say "--fast: make qa skipped"; else run_gate qa; fi

report HEAD "$UP_BRANCH"
if [ "$GATE_FAIL" = 1 ]; then
  echo "[sync] gates failed; $BR left in place for inspection (not pushed)" >&2
  exit 2
fi
say "done on branch $BR. Review it, then merge into $MAIN yourself. Nothing was pushed."
