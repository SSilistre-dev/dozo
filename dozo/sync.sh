#!/usr/bin/env bash
# Pull upstream (Rakazo) into a review branch of the Dozo fork. Never pushes, never touches main.
# See dozo/SYNC.md. Exit codes: 0 ok / up to date, 1 error or gate failure, 2 refused (non-fast-forward
# upstream-main) or merge conflict.
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
never rebase). Then runs `make olc` and `make qa` when those targets exist.

  --dry-run  fetch and report what would be merged and predicted conflicts
             (git merge-tree). Changes no branch, index or file.
  --fast     run only `make olc`, skip `make qa`
  --help     this text

Never pushes. The maintainer reviews the sync branch and merges it into main.
Exit 2: upstream-main is not a fast-forward, or the merge conflicts.
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

cd "$(git rev-parse --show-toplevel)"

git remote get-url "$UP_REMOTE" >/dev/null 2>&1 || die "remote '$UP_REMOTE' not found. Add it: git remote add upstream https://github.com/elie222/rakazo.git"
git rev-parse --verify -q "refs/heads/$MAIN" >/dev/null || die "branch '$MAIN' not found"

if [ "$DRY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "working tree is not clean; commit or stash first (--dry-run does not need a clean tree)"
fi

say "fetching $UP_REMOTE main"
git fetch --quiet "$UP_REMOTE" main
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

# Pathspec for "files that should be identical to upstream" (everything outside our own paths).
# Fork files named dozo-* inside apps/ and packages/ are ours too (see dozo/AGENTS.md).
OWN=(. ':!dozo' ':!Makefile' ':!.github/workflows/dozo-*.yml'
     ':!packages/ui-web/src/dozo.css'
     ':(exclude,glob)apps/**/dozo-*' ':(exclude,glob)packages/**/dozo-*')

fork_files() { git ls-tree -r --name-only "$1" -- apps packages | grep '/dozo-[^/]*$' || true; }  # $1 = tree-ish

# Upstream must never ship a dozo-* file of its own: it would overwrite or conflict with ours.
CLASH=$(fork_files "$NEW_SHA")
[ -z "$CLASH" ] || die "upstream ships dozo-* file(s) that clash with the fork's own naming; rename ours first: $(printf '%s' "$CLASH" | tr '\n' ' ')" 2

health() { # $1 = tree-ish holding our result, $2 = upstream ref to compare with
  HEALTH_FILES=$(git diff --name-only "$2" "$1" -- "${OWN[@]}")
  HEALTH=$([ -n "$HEALTH_FILES" ] && printf '%s\n' "$HEALTH_FILES" | wc -l | tr -d ' ' || echo 0)
}

report() { # $1 = tree-ish of the merge result, $2 = upstream ref
  health "$1" "$2"
  say "range merged:        $RANGE"
  say "upstream commits:    $COMMITS"
  say "files changed:       $FILES"
  say "fork files:          $(fork_files "$1" | grep -c . || true) dozo-* file(s) inside apps/ and packages/, kept as ours"
  say "fork health:         $HEALTH upstream-tracked file(s) differ from upstream outside our paths"
  if [ "$HEALTH" -gt 1 ]; then
    echo "[sync] WARNING: fork health above 1. Someone edited upstream files; these will conflict later:" >&2
    printf '[sync]   %s\n' $HEALTH_FILES >&2
  fi
}

if git merge-base --is-ancestor "$NEW_SHA" "$MAIN"; then
  say "main already contains upstream $SHORT; nothing to merge"
  [ "$DRY" = 1 ] || { [ "$OLD_UP" = "$NEW_SHA" ] || git update-ref -m "dozo/sync: ff $UP_BRANCH" "refs/heads/$UP_BRANCH" "$NEW_SHA" "$OLD_UP"; }
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
  if [ "$ORIG" = "$UP_BRANCH" ]; then git merge --ff-only --quiet "$NEW_SHA"
  else git update-ref -m "dozo/sync: ff $UP_BRANCH" "refs/heads/$UP_BRANCH" "$NEW_SHA" "$OLD_UP"; fi
  say "$UP_BRANCH fast-forwarded to $SHORT"
fi

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
say "merge clean on $BR"

# Gates, if the colleague's Makefile targets exist.
have_target() { [ -f Makefile ] && make -n "$1" >/dev/null 2>&1; }
GATE_FAIL=0
run_gate() {
  if have_target "$1"; then
    say "running make $1"
    make "$1" || { echo "[sync] make $1 FAILED" >&2; GATE_FAIL=1; }
  else
    say "NOTICE: make target '$1' not available (no Makefile or no such target), skipped"
  fi
}
run_gate olc
if [ "$GATE_FAIL" = 0 ]; then
  if [ "$FAST" = 1 ]; then say "--fast: make qa skipped"; else run_gate qa; fi
fi

report HEAD "$UP_BRANCH"
if [ "$GATE_FAIL" = 1 ]; then
  echo "[sync] gates failed; $BR left in place for inspection (not pushed)" >&2
  exit 1
fi
say "done on branch $BR. Review it, then merge into $MAIN yourself. Nothing was pushed."
