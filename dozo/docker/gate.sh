#!/usr/bin/env bash
# Gates: olc (fast, offline once the Node image is local, <30s) and qa (full).
# Usage: gate.sh olc|qa|unit. Exit 0 pass, 2 any failed gate, 64 usage, 130/143 interrupted.
# `upstream-edits <base> [tree]` prints the upstream files that differ from <base> (shared with
# sync.sh); it is not a gate. What each gate runs and every variable: dozo/docker/README.md.
# `unit` runs the fork's own dozo-*.test.ts(x) on the branded staged tree, with a coverage floor.
# `qa` runs olc, stage, brand, unit, build, up, smoke, down as logged, timed steps (see qa()).
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lock.sh"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
PWD0="$PWD"
cd "$ROOT"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
# Docker reads a relative -v source as a named volume: make it absolute once (against the caller's
# directory) and pass it on to build.sh.
case "$STAGE" in /*) ;; *) STAGE="$PWD0/${STAGE#./}" ;; esac
export DOZO_STAGE_DIR="$STAGE"
LOGS="$STAGE/logs"
FAILS=()
PARTIAL=""
partial() { PARTIAL="${PARTIAL:+$PARTIAL; }$1"; }
# A variable that changes what a gate checks makes its verdict partial, whoever set it.
for v in DOZO_STAGE_REF DOZO_UNIT_SRC DOZO_COVERAGE_MIN DOZO_BRAND_COVERAGE_MIN; do [ -z "${!v:-}" ] || partial "$v set"; done
# Fork-owned tests live inside upstream dirs as dozo-*.test.ts(x). The unit step expects as many in
# the staged tree as the committed tree has (counted there, never written here), so a deleted test
# fails; deleting one on purpose means committing the deletion.
# Coverage floor (percent) for lines, branches and functions of the fork's own code.
COV_MIN="${DOZO_COVERAGE_MIN:-90}"
# The brand codemod's own floor (percent), per file and overall. Just under what it measures today
# (100 lines, 98.9 branches, 100 functions); a separate variable so the web unit floor is unaffected.
BRAND_COV_MIN="${DOZO_BRAND_COVERAGE_MIN:-97}"
# The pristine upstream branch the upstream-edit check compares with (override for tests only).
UP_REF="${DOZO_UPSTREAM_REF:-upstream-main}"
# The upstream file the fork may edit inside the marked block at its top (the other exception: below).
README_FILE="README.md"
README_START="<!-- dozo:fork-notice:start -->"
README_END="<!-- dozo:fork-notice:end -->"
# The second exception (dozo/AGENTS.md, Invariants): GitHub reads the "New issue" forms from these
# paths only, so the fork replaces upstream's whole. Exact names, never a pattern: a neighbour is
# still upstream's. Replacing is allowed; deleting or retyping one is not (dozo/SYNC.md).
OWNED_FILES=(.github/ISSUE_TEMPLATE/config.yml .github/ISSUE_TEMPLATE/bug.yml .github/ISSUE_TEMPLATE/self-host.yml)
# What an owned file must not say again: it is ours so that nothing in it points at upstream.
UPSTREAM_NAME="rakazo"
fail() { FAILS+=("$1"); echo "[gate] FAIL: $1"; }
now() { date +%s; }

# Every container this run starts has --init (so TERM reaches PID 1), a name unique to the run and a
# label, and on_exit/on_signal remove whatever carries the label: a killed `docker run` client
# leaves its container running otherwise. The label, not a variable, so a call inside $( ) counts.
RUN_ID="gate-$$"
drun() { local kind="$1"; shift; docker run --init --rm --name "dozo-$kind-$$" --label "dozo.run=$RUN_ID" "$@"; }
rm_run_containers() {
  local ids; ids=$(docker ps -aq --filter "label=dozo.run=$RUN_ID" 2>/dev/null) || return 0
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
}
# Wait until $1 is gone, however many trapped signals cut a `wait` short; the exit status is in
# WAIT_RC. A second Ctrl-C during cleanup must not leave the child running while we report failure.
# `wait` runs at least once: a child that already exited and was reaped has no process left for
# `kill -0` to find, and a loop that tests first would report 0 for a step that failed. A status
# above 128 may be a signal that cut the wait short after the child ended: ask once more (a status
# already collected answers 127, or the same status again on bash 3.2, so it never overwrites).
# The same function is in dozo/e2e/run.sh.
WAIT_RC=0
wait_gone() {
  local rc again
  while :; do wait "$1"; rc=$?; kill -0 "$1" 2>/dev/null || break; done
  if [ "$rc" -gt 128 ]; then wait "$1"; again=$?; [ "$again" -eq 127 ] || rc=$again; fi
  WAIT_RC=$rc
}

# A skipped check must never end in PASS: CI pulls the image and fails if it cannot, a local run
# fails with the one command that fixes it (olc stays offline and fast once the image is cached).
node_image() {
  docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 && return 0
  # No daemon is not a missing image: a pull hint would send the reader the wrong way.
  docker info >/dev/null 2>&1 || { fail "cannot reach the Docker daemon (is it running, and may this user use it?)"; return 1; }
  if [ -n "${CI:-}" ]; then
    echo "[gate] CI: pulling $NODE_IMAGE"
    docker pull -q "$NODE_IMAGE" >/dev/null && return 0
    fail "cannot pull $NODE_IMAGE"; return 1
  fi
  fail "$NODE_IMAGE not present locally; run: docker pull $NODE_IMAGE"; return 1
}

# Print the coverage rows (and the tool's own threshold errors) that are below the floor ($1,
# default the web unit floor). Field 1 is the file name and the last field the uncovered lines, so
# only fields 2..NF-1 are numbers to compare; directory rows have empty number fields.
coverage_misses() { # stdin = tool output
  awk -F'|' -v min="${1:-$COV_MIN}" '
    /does not meet|threshold/ { print; next }
    NF >= 4 { for (i = 2; i < NF; i++) if ($i ~ /[0-9]/ && $i + 0 < min) { print; break } }'
}

# Names ($@) that no row of the coverage table on stdin lists: a source file that no test imports
# never appears in the report, so a global threshold cannot see it.
coverage_unlisted() {
  awk -F'|' -v names="$*" '
    BEGIN { n = split(names, want, " ") }
    NF >= 4 && $2 ~ /[0-9]/ { f = $1; sub(/[ \t]+$/, "", f); sub(/.*[ \t]/, "", f); seen[f] = 1 }
    END { for (i = 1; i <= n; i++) if (!(want[i] in seen)) print want[i] }'
}

# True when the root README (of tree-ish $2, default the working tree), with the marked fork-notice
# block and the one blank line after it removed, equals upstream's README at the merge base ($1). A
# missing end marker strips the rest of the file, so it differs; a README that upstream does not
# have is ours.
readme_outside_block() {
  git cat-file -e "$1:$README_FILE" 2>/dev/null || return 0
  { if [ -n "${2:-}" ]; then git show "$2:$README_FILE" 2>/dev/null; else cat "$README_FILE" 2>/dev/null; fi; } \
    | awk -v s="$README_START" -v e="$README_END" '
    $0 == s { skip = 1; next }
    $0 == e { skip = 0; blank = 1; next }
    skip { next }
    blank && $0 == "" { blank = 0; next }
    { blank = 0; print }' | cmp -s - <(git show "$1:$README_FILE")
}

# dozo/AGENTS.md: the fork edits no upstream file but the marked block of the root README.md and the
# owned issue forms ($OWNED_FILES: a changed one is ours, a deleted or retyped one is listed). Prints
# the files that differ from upstream's commit $1 (edited, deleted, retyped; added files are ours),
# one per line, in tree-ish $2 or, without it, in the working tree. The one computation behind both
# `make olc` and sync.sh's fork-health count (`gate.sh upstream-edits <base> [tree]`). Exit 2 when
# git cannot compute it.
upstream_edits() {
  local base="${1:-}" tree="${2:-}" bad gone
  [ -n "$base" ] || { echo "usage: $0 upstream-edits <base-commit> [tree-ish]" >&2; return 64; }
  bad=$(git diff --name-only --no-renames --diff-filter=MDT "$base" ${tree:+"$tree"} -- . ':!dozo' ':!Makefile') || return 2
  gone=$(git diff --name-only --no-renames --diff-filter=DT "$base" ${tree:+"$tree"} -- "${OWNED_FILES[@]}") || return 2
  bad=$(printf '%s\n' "$bad" | grep -vxF -e "$README_FILE" $(printf -- '-e %s ' "${OWNED_FILES[@]}") || true)
  [ -z "$gone" ] || bad=$(printf '%s\n%s' "$bad" "$(printf '%s\n' "$gone" | sed 's/$/ (owned issue form deleted or retyped)/')")
  # The stage drops the root Makefile as the fork's own: one in upstream would be shadowed unnoticed.
  ! git cat-file -e "$base:Makefile" 2>/dev/null || bad=$(printf '%s\nMakefile (upstream has a root Makefile: the fork'"'"'s shadows it and the stage deletes it)' "$bad")
  readme_outside_block "$base" "$tree" || bad=$(printf '%s\n%s' "$bad" "$README_FILE (outside the fork-notice block)")
  printf '%s\n' "$bad" | sed '/^$/d'
}

# The owned issue forms (working tree) that name upstream: a sync resolved with upstream's side, or
# a line of upstream's that merged in cleanly, would send our users' reports to upstream again.
owned_naming_upstream() {
  local f
  for f in "${OWNED_FILES[@]}"; do [ ! -f "$f" ] || ! grep -qi "$UPSTREAM_NAME" "$f" || echo "$f"; done
}

# Each shell script is syntax-checked by its own interpreter (a #!/bin/sh script is not bash).
syntax_check() { # $1 = script
  local sh=bash
  case "$(head -n 1 "$1")" in '#!/bin/sh'*|'#!/usr/bin/env sh'*) sh=sh ;; esac
  "$sh" -n "$1" && echo "[olc] $sh -n $1 ok" || fail "syntax $1"
}

olc() {
  local s out f tests report low missing brand_src rc e2e_tests mjs
  # Every shell script under dozo/ (docker, sync, e2e/run.sh, brand assets), found, not listed, so a
  # new one is covered. The e2e .ts files have no cheap check (node --check cannot strip types, tsc
  # is not in the image): Playwright compiles them when `make e2e` runs. The macOS app's toolchain
  # and build output (dozo/desktop/.toolchain, target: git-ignored, third-party) are not ours to check.
  while IFS= read -r s; do syntax_check "$s"; done \
    < <(find dozo \( -path dozo/.stage -o -name node_modules -o -path dozo/desktop/.toolchain -o -path dozo/desktop/target \) -prune -o -type f -name '*.sh' -print | sort)
  mjs=(); while IFS= read -r f; do mjs+=("$f"); done < <(find dozo \( -path dozo/.stage -o -name node_modules -o -path dozo/desktop/.toolchain -o -path dozo/desktop/target \) -prune -o -type f -name '*.mjs' -print 2>/dev/null)
  if [ "${#mjs[@]}" -eq 0 ]; then fail "no .mjs files under dozo/: nothing to check with node"
  elif node_image; then
    drun node-check -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" sh -c 'for f in "$@"; do node --check "$f" || exit 1; done' _ "${mjs[@]}" \
      && echo "[olc] node --check ${#mjs[@]} files ok" || fail "node --check"
    tests=$(find dozo/brand -type f -name '*.test.*' -print -quit 2>/dev/null)  # captured: `find | grep -q` can SIGPIPE under pipefail
    if [ -n "$tests" ]; then
      # Quiet on success; on failure the whole output is the reason. Node's thresholds are global, so
      # the table is also read per file: a file under the floor, and a source file that no test
      # imports (it never appears in the table), fail even when the totals are fine. The test files
      # are split by topic (Node runs one process per file); `*.test-support.mjs` holds their shared
      # fixtures and is neither a pinned module nor in the coverage report.
      brand_src=$(find dozo/brand -maxdepth 1 -type f -name '*.mjs' ! -name '*.test.mjs' ! -name '*.test-support.mjs' -exec basename {} \; | sort | tr '\n' ' ')
      out=$(drun brand-test --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test --experimental-test-coverage \
        --test-coverage-exclude='dozo/brand/*.test-support.mjs' \
        --test-coverage-lines="$BRAND_COV_MIN" --test-coverage-branches="$BRAND_COV_MIN" --test-coverage-functions="$BRAND_COV_MIN" 'dozo/brand/*.test.mjs' 2>&1); rc=$?
      report=$(printf '%s\n' "$out" | sed -n '/start of coverage report/,/end of coverage report/p')
      low=$(printf '%s\n' "$report" | coverage_misses "$BRAND_COV_MIN")
      # shellcheck disable=SC2086
      missing=$(printf '%s\n' "$report" | coverage_unlisted $brand_src)
      if [ "$rc" -eq 0 ] && [ -z "$low" ] && [ -z "$missing" ]; then echo "[olc] brand unit tests ok, coverage >= $BRAND_COV_MIN% in every file ($(echo $brand_src | wc -w | tr -d ' ') modules)"
      else
        printf '%s\n' "$out"
        [ -z "$low" ] || printf '%s\n' "$low" | sed 's/^/[olc] below floor: /'
        [ -z "$missing" ] || printf '%s\n' "$missing" | sed 's/^/[olc] not in the coverage report (no test imports it): dozo\/brand\//'
        fail "brand unit tests or coverage"
      fi
    else fail "no brand tests under dozo/brand (a check that cannot run is a failure)"; fi
    # The e2e helpers that need no browser (the offline model server, route matching, the coverage
    # verdict): Node's own test runner on every dozo/e2e/*.test.mjs, about a second.
    if [ -f dozo/e2e/model-stub.test.mjs ]; then
      e2e_tests=(dozo/e2e/*.test.mjs)
      out=$(drun e2e-helper-test --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test "${e2e_tests[@]}" 2>&1) \
        && echo "[olc] e2e helper tests ok (${#e2e_tests[@]} files)" || { printf '%s\n' "$out"; fail "e2e helper tests"; }
    else fail "dozo/e2e/model-stub.test.mjs missing: the e2e model stub is not tested"; fi
    # Every anchored rule's file and anchor, and every `requires` file, against the repository's own
    # tree: a dry run (--check) that writes nothing, so a rule broken by an upstream change or a
    # renamed wrapper fails here and not only at `make qa`. --strict: the committed tree is
    # unbranded, so no rule can already be applied (that would be drift hidden by a short replace).
    if [ -f dozo/brand/apply.mjs ]; then
      out=$(drun brand-rules --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node dozo/brand/apply.mjs --check --allow-git --strict --root /r 2>&1) \
        && echo "[olc] brand rules match the tree: $(printf '%s\n' "$out" | grep '^hooks:')" \
        || { printf '%s\n' "$out"; fail "brand rules do not match the tree (apply.mjs --check)"; }
    else fail "dozo/brand/apply.mjs missing: brand rules not checked"; fi
  fi
  local files forkfiles bad base upwf
  files=$(find dozo \( -path dozo/.stage -o -path dozo/desktop/.toolchain -o -path dozo/desktop/target \) -prune -o -type f -print | wc -l | tr -d ' ')
  forkfiles=$(git ls-files --cached --others --exclude-standard -- apps packages | grep -c '/dozo-[^/]*$' || true)
  # Upstream's workflows arrive enabled after a sync (dozo/SYNC.md): a changed count is the cue to look.
  upwf=$(find .github/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) ! -name 'dozo-*' 2>/dev/null | wc -l | tr -d ' ')
  echo "[olc] rules: dozo files=$files, dozo-* fork files inside upstream dirs=$forkfiles, upstream workflows=$upwf"
  # Compared with the merge base, not the tip of $UP_REF: after an aborted sync or a daily sync on
  # origin the ref is ahead, and everything upstream changed since would look like our edit. A check
  # that cannot run fails: without the ref, nothing says what upstream's files are.
  if upstream_ref_ok; then
    if base=$(git merge-base HEAD "$UP_REF" 2>/dev/null) && [ -n "$base" ]; then
      if ! bad=$(upstream_edits "$base"); then fail "upstream-edit check: git diff against the merge base failed"
      elif [ -z "$bad" ]; then echo "[olc] upstream files edited outside the allowed set ($README_FILE notice block, ${#OWNED_FILES[@]} issue forms): 0"
      else printf '%s\n' "$bad" | sed "s/^/[olc] upstream file differs from the merge base with $UP_REF: /"; fail "upstream files edited: $(printf '%s\n' "$bad" | grep -c .)"; fi
    else fail "no merge base between HEAD and $UP_REF: the upstream-edit check cannot run"; fi
  else fail "$UP_REF ref missing: the upstream-edit check cannot run. Create it: git fetch upstream main && git branch $UP_REF upstream/main"; fi
  bad=$(owned_naming_upstream)
  [ -z "$bad" ] || { printf '%s\n' "$bad" | sed 's/^/[olc] owned issue form names upstream: /'; fail "owned issue forms name upstream: $(printf '%s\n' "$bad" | grep -c .)"; }
  selftest
}

# Pure shell logic that needs no Docker: wait_gone and the coverage parsers, against fixtures of a Vitest table and
# of Node's test-runner table (a tree: directory rows, indented names, empty number fields). Each
# case pins one way the parser could go wrong; see the comments. The stage overlay, the dc env
# cleaning and the lock owner's start time are in build.test.sh (a scratch git repository). Not covered: the unit volume sync, the compose steps and
# with_timeout (they need a Docker daemon).
selftest() {
  local got ok=1 vitest node edge
  # Here-strings, not heredocs inside $( ): bash 3.2 mis-parses a ")" there.
  vitest=$' File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s\n All files |   96.00 |    92.00 |     100 |     100 |\n ok.ts     |     100 |      100 |     100 |     100 | 12-30\n low.ts    |     100 |    80.50 |     100 |     100 |\nERROR: Coverage for lines (85%) does not meet global threshold (90%)'
  expect_misses "vitest table" 90 "$vitest" $' low.ts    |     100 |    80.50 |     100 |     100 |\nERROR: Coverage for lines (85%) does not meet global threshold (90%)' || ok=0
  # Node's table: v2.mjs has a digit in its name (the name field is never compared); dir rows are
  # empty; fine.mjs lists uncovered lines "1-2" in the last field (never compared); edge.mjs sits
  # exactly on the floor (not a miss); lib.mjs is just under it; two.mjs has two low columns (one
  # row printed once); only.mjs has only the first column low; short.mjs has no uncovered column.
  node=$'ℹ file        | line % | branch % | funcs % | uncovered lines\nℹ ------------------------------\nℹ dozo        |        |          |         | \nℹ  brand      |        |          |         | \nℹ   v2.mjs    | 100.00 |   100.00 |  100.00 | \nℹ   fine.mjs  | 100.00 |   100.00 |  100.00 | 1-2\nℹ   edge.mjs  | 100.00 |    97.00 |  100.00 | \nℹ   lib.mjs   | 100.00 |    96.99 |  100.00 | 3-4\nℹ   two.mjs   |  80.00 |    70.00 |  100.00 | \nℹ   only.mjs  |  50.00 |   100.00 |  100.00 | \nℹ   short.mjs |  50.00 |   100.00 |  100.00\nℹ all files   | 100.00 |    98.89 |  100.00 | '
  expect_misses "node table" 97 "$node" $'ℹ   lib.mjs   | 100.00 |    96.99 |  100.00 | 3-4\nℹ   two.mjs   |  80.00 |    70.00 |  100.00 | \nℹ   only.mjs  |  50.00 |   100.00 |  100.00 | \nℹ   short.mjs |  50.00 |   100.00 |  100.00' || ok=0
  # Each of the tool's own messages is printed on its own; a log line with a few pipes is not a row.
  expect_misses "threshold messages" 90 $'a does not meet it\nb threshold missed\nnote | 5 | x\nplain line' $'a does not meet it\nb threshold missed' || ok=0
  edge=$'x.mjs | 89.99 | 100 | 100 | '
  expect_misses "just under the floor" 90 "$edge" "$edge" || ok=0
  expect_misses "exactly the floor" 90 $'x.mjs | 90.00 | 100 | 100 | ' "" || ok=0
  # Files a test never imports are absent from the table: names listed, a substring is not a listing.
  # d.mjs has a row with empty number fields only (a directory-style row): that is not a listing.
  got=$(coverage_unlisted a.mjs b.mjs c.mjs d.mjs <<< $'ℹ dozo | | | | \nℹ  brand | | | | \nℹ   a.mjs | 100.00 | 100.00 | 100.00 | \nℹ   xb.mjs | 100.00 | 100.00 | 100.00 | \nℹ   c.mjs | 100.00 | 100.00 | 100.00 | 4\nℹ   d.mjs | | | | ')
  [ "$got" = $'b.mjs\nd.mjs' ] || { ok=0; echo "[olc] coverage_unlisted: got '$got', want 'b.mjs, d.mjs'"; }
  # wait_gone keeps the child's own status. An instant failure already reaped before the first wait
  # (the old loop tested `kill -0` first and reported 0); a code above 128; a trapped signal that cuts
  # the first wait short while the child still runs; a success.
  trap ':' USR1
  ( sleep 0.1; kill -USR1 $$ ) &
  check_wait "interrupted wait" 4 0 'sleep 0.4; exit 4' || ok=0
  trap - USR1
  check_wait "instant failure, reaped before the wait" 3 0.2 'exit 3' || ok=0
  check_wait "status above 128" 130 0.2 'exit 130' || ok=0
  check_wait "success" 0 0.2 'exit 0' || ok=0
  # timed_out: TERM was enough (124), KILL after the limit (137), the step's own kill before it, a plain failure.
  timed_out 124 5 600 && timed_out 137 600 600 && timed_out 137 610 600 \
    && ! timed_out 137 599 600 && ! timed_out 2 700 600 && ! timed_out 0 700 600 || { ok=0; echo "[olc] selftest timed_out: wrong verdict"; }
  selftest_owned || ok=0
  # The shell logic of build.sh and lock.sh (stage overlay, dc env, lock owner), in a scratch repo.
  out=$(bash "$ROOT/dozo/docker/build.test.sh" 2>&1) || { ok=0; printf '%s\n' "$out"; }
  [ "$ok" = 1 ] && echo "[olc] selftest: coverage parsers, wait_gone, timed_out, owned issue forms and build.test.sh ok" || fail "selftest (coverage parsers, wait_gone, timed_out, owned issue forms or build.test.sh)"
}
# The allowed set of the upstream-edit check, in a scratch repository. For every owned file: a
# changed one is not listed; a deleted one and one that names upstream are; a file whose name only
# starts with it and one of the same name elsewhere are listed. So are another issue form and the
# README outside its block, as before.
selftest_owned() (
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/dozo-gatetest-XXXXXX") || exit 1
  trap 'rm -rf "$tmp"' EXIT
  cd "$tmp" || exit 1
  g() { git -c user.name=t -c user.email=t@example.invalid -c core.autocrlf=false "$@"; }
  want() { # name expected-output; restores the tree afterwards
    local got; got=$(upstream_edits "$base") || { echo "[olc] selftest owned $1: upstream_edits failed"; rc=1; }
    [ "$got" = "$2" ] || { echo "[olc] selftest owned $1: got '$got', want '$2'"; rc=1; }
    g checkout -q -- .
  }
  rc=0
  for f in README.md .github/ISSUE_TEMPLATE/other.yml "${OWNED_FILES[@]}"; do
    for n in "$f" "$f.bak" "sub/$f"; do mkdir -p "$(dirname "$n")"; echo "upstream" > "$n"; done
  done
  g init -q && g add -A && g commit -qm base || exit 1
  base=$(g rev-parse HEAD)
  want "untouched tree" ""
  for f in "${OWNED_FILES[@]}"; do
    echo ours > "$f"
    [ -z "$(owned_naming_upstream)" ] || { echo "[olc] selftest owned: $f without the name was reported"; rc=1; }
    want "changed $f" ""
    echo "see ${UPSTREAM_NAME}.example" > "$f"
    [ "$(owned_naming_upstream)" = "$f" ] || { echo "[olc] selftest owned: $f naming upstream was not reported"; rc=1; }
    rm "$f"; want "deleted $f" "$f (owned issue form deleted or retyped)"
    echo ours > "$f.bak"; echo ours > "sub/$f"
    want "neighbours of $f" "$f.bak"$'\n'"sub/$f"
  done
  echo ours > .github/ISSUE_TEMPLATE/other.yml; echo ours >> README.md
  want "files outside the set" $'.github/ISSUE_TEMPLATE/other.yml\nREADME.md (outside the fork-notice block)'
  exit "$rc"
)
expect_misses() { # name min fixture want
  local got; got=$(coverage_misses "$2" <<< "$3")
  [ "$got" = "$4" ] && return 0
  echo "[olc] selftest $1: got:"; printf '%s\n' "$got" | sed 's/^/[olc]   /'; return 1
}

check_wait() { # name want delay body: run body in the background, wait_gone it after delay seconds
  local p; ( eval "$4" ) & p=$!
  sleep "$3"; wait_gone "$p"
  [ "$WAIT_RC" = "$2" ] && return 0
  echo "[olc] selftest wait_gone $1: got $WAIT_RC, want $2"; return 1
}

upstream_ref_ok() { git rev-parse --verify -q "$UP_REF^{commit}" >/dev/null; }

# Fork tests on the branded staged tree, in a container; nothing is written to the host.
# Cost: a cold run installs everything (~40 s) and adds the coverage provider (~35 s). The volume
# dozo-qa-deps keeps the pnpm store, the corepack download and the installed node_modules, so an
# unchanged lockfile skips all of it. One fixed volume: the in-volume marker below notices a changed
# lockfile and reinstalls into it, so old lockfiles never pile up as one full node_modules each. It runs as root because it writes only
# to that volume; the staged tree is mounted read-only.
unit_tests() {
  local src="${DOZO_UNIT_SRC:-$STAGE/src}" tests n want vol out
  # Docker reads a relative -v source as a named volume: make it absolute, as STAGE is.
  case "$src" in /*) ;; *) src="$PWD0/${src#./}" ;; esac
  [ -d "$src/apps" ] || { fail "unit: no staged tree, run dozo/docker/build.sh stage and brand first"; return 1; }
  # A stage swap cut short leaves a partial tree and no completion marker (build.sh writes it last).
  [ -n "${DOZO_UNIT_SRC:-}" ] || [ -f "$STAGE/stage.complete" ] || { fail "unit: the staged tree is incomplete (no $STAGE/stage.complete); run dozo/docker/build.sh stage again"; return 1; }
  tests=$(cd "$src" && find apps packages \( -name node_modules -prune \) -o -type f \( -name 'dozo-*.test.ts' -o -name 'dozo-*.test.tsx' \) -print | sort)
  n=$(printf '%s' "$tests" | grep -c . || true)
  want=$(git ls-tree -r --name-only "${DOZO_STAGE_REF:-HEAD}" -- apps packages | grep -Ec '/dozo-[^/]*\.test\.tsx?$' || true)
  echo "[unit] fork test files found: $n (the committed tree has $want)"
  if [ "$want" -lt 1 ]; then fail "unit: the committed tree has no fork test files"; return 1; fi
  if [ "$n" -lt "$want" ]; then fail "unit: $n fork test files, the committed tree has $want (a deleted test is a failure; commit the deletion if it is meant)"; return 1; fi
  node_image || return 1
  vol=dozo-qa-deps
  out=$(mktemp "${TMPDIR:-/tmp}/dozo-unit-XXXXXX"); UNIT_OUT=$out  # removed by the EXIT trap if interrupted
  # The coverage provider is not a project dependency: it is added inside the container only, at
  # the version of the staged tree's vitest, so the working tree's package.json is never touched.
  # In the background and waited for, so a TERM to this script is handled at once (a foreground
  # pipeline would hold the trap until the run ends) and removes the named container.
  # shellcheck disable=SC2086
  ( drun unit -v "$src:/src:ro" -v "$vol:/cache" -e CI=1 -e COREPACK_HOME=/cache/corepack \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e DOZO_COVERAGE_MIN="$COV_MIN" "$NODE_IMAGE" sh -c 'set -e
      mkdir -p /cache/w /cache/store; cd /cache/w
      want=$(sha256sum /src/pnpm-lock.yaml | cut -d" " -f1)
      # Sync incrementally (no rsync in the image): a manifest of path, size and mtime in seconds per
      # file on both sides. Files only in the volume go; files new or different in the stage are
      # copied (tar keeps the mtime); the rest is left alone. Every node_modules and data/ are kept.
      export LC_ALL=C
      manifest() { (cd "$1" && find . -name node_modules -prune -o -path ./data -prune -o \( -type f -o -type l \) -printf "%p\t%s\t%Ts\0" | sort -z); }
      manifest /src > /tmp/src.m; manifest /cache/w > /tmp/vol.m
      cut -z -f1 /tmp/src.m > /tmp/src.p; cut -z -f1 /tmp/vol.m > /tmp/vol.p
      comm -z -13 /tmp/src.p /tmp/vol.p | xargs -0 -r rm -f
      comm -z -23 /tmp/src.m /tmp/vol.m | cut -z -f1 > /tmp/changed
      if [ -s /tmp/changed ]; then tar -C /src --null -T /tmp/changed -cf - | tar -C /cache/w -xf -; fi
      echo "[unit] sync: $(tr -cd "\0" < /tmp/changed | wc -c) file(s) copied, $(comm -z -13 /tmp/src.p /tmp/vol.p | tr -cd "\0" | wc -c) removed"
      corepack enable
      if [ "$(cat node_modules/.dozo-deps 2>/dev/null)" != "$want" ]; then
        echo "[unit] deps: cold cache or lockfile changed, installing"
        rm -f node_modules/.dozo-deps
        pnpm install --frozen-lockfile --store-dir /cache/store --loglevel=warn
        v=$(node -p "require(\"./node_modules/vitest/package.json\").version")
        pnpm add -Dw "@vitest/coverage-v8@$v" --store-dir /cache/store --loglevel=warn
        echo "$want" > node_modules/.dozo-deps
      else echo "[unit] deps: cached"; fi
      # The database client is generated, not committed: an api test that reaches @rakazo/db cannot
      # load without it. The sync above removes the files of the last one and leaves its directories,
      # which the generator refuses, so it starts from nothing each time (about 3 seconds).
      rm -rf packages/db/src/generated
      pnpm --filter @rakazo/db generate > /tmp/generate.log 2>&1 || { cat /tmp/generate.log; exit 1; }
      m=${DOZO_COVERAGE_MIN:-90}
      pnpm exec vitest run "$@" --coverage --coverage.reporter=text \
        --coverage.include="apps/**/dozo-*.ts" --coverage.include="apps/**/dozo-*.tsx" \
        --coverage.include="packages/**/dozo-*.ts" --coverage.include="packages/**/dozo-*.tsx" \
        --coverage.exclude="**/*.test.*" --coverage.thresholds.perFile \
        --coverage.thresholds.lines="$m" --coverage.thresholds.branches="$m" --coverage.thresholds.functions="$m"' \
    _ $tests 2>&1 | tee "$out"; exit "${PIPESTATUS[0]}" ) &
  wait_gone $!
  if [ "$WAIT_RC" -eq 0 ]; then echo "[unit] fork tests ok, per-file coverage >= $COV_MIN%"; rm -f "$out"
  else coverage_misses "$COV_MIN" < "$out" | sed 's/^/[unit] below floor: /'; rm -f "$out"; fail "unit: fork tests or coverage (vitest)"; return 1; fi
}

# --- qa: logged, timed steps ---
# The last full run lasted more than 45 minutes with no log: every step now writes its whole output
# to $LOGS/<step>.log, the terminal gets one start line and one end line per step (plus the last 40
# log lines on failure), and no step can run past its timeout.
TIMEOUT_BIN="${DOZO_TIMEOUT_BIN-$(command -v timeout || command -v gtimeout || true)}"

step_timeout() { # DOZO_TIMEOUT_<STEP> overrides, seconds
  local v d=600
  v="DOZO_TIMEOUT_$(printf '%s' "$1" | tr a-z A-Z)"
  case "$1" in build) d=2400 ;; unit) d=900 ;; esac
  echo "${!v:-$d}"
}

kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill -TERM "$1" 2>/dev/null; return 0; }

# The running step and its watchdog, so a signal can clean both up. They are cleared as soon as the
# step is reaped: a later cleanup must never signal a pid the system has since reused.
WT_PID=""; WT_WD=""
wt_stop() { # idempotent; the watchdog goes first so it cannot fire at a step that is already gone
  # The watchdog dies by our TERM: its "Terminated" job notice is noise, so stderr is dropped here.
  [ -z "$WT_WD" ] || { kill_tree "$WT_WD"; wait_gone "$WT_WD"; } 2>/dev/null
  [ -z "$WT_PID" ] || kill_tree "$WT_PID"
  WT_PID=""; WT_WD=""
}

# Exit 124 on timeout, like timeout(1). Without it (macOS has none) a background watchdog does it.
# The step always runs in the background and is waited for (wait_gone: a second signal during
# cleanup cuts one `wait` short, not the cleanup): a foreground wait would hold a trapped signal until
# the step ends. Without job control the step shares our process group, so "its group"
# is its process tree (kill_tree), never a group kill that would take this script with it.
with_timeout() { # seconds cmd...
  local limit="$1" pid flag rc; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 10 "$limit" "$@" & WT_PID=$!
    wait_gone "$WT_PID"; rc=$WAIT_RC; WT_PID=""
    return "$rc"
  fi
  flag=$(mktemp "${TMPDIR:-/tmp}/dozo-timeout-XXXXXX"); rm -f "$flag"
  "$@" & pid=$!; WT_PID=$pid
  ( sleep "$limit"; : > "$flag"; kill_tree "$pid"; sleep 10; kill -KILL "$pid" 2>/dev/null ) & WT_WD=$!
  wait_gone "$pid"; rc=$WAIT_RC; WT_PID=""   # reaped: wt_stop must not signal a pid the system may reuse
  wt_stop
  if [ -e "$flag" ]; then rm -f "$flag"; return 124; fi
  return "$rc"
}

# Set while qa owns a stack it started (never one that was already running).
QA_OWNS_STACK=0
on_signal() { # $1 = exit code (128 + signal number)
  trap ':' INT TERM   # a second signal must not cut the cleanup short; ':' is not inherited by children
  echo "[gate] interrupted"
  wt_stop
  if [ "$QA_OWNS_STACK" -eq 1 ]; then
    QA_OWNS_STACK=0
    echo "[qa] taking down the stack qa started"
    with_timeout 300 "$ROOT/dozo/docker/build.sh" down >>"$LOGS/down.log" 2>&1 || echo "[qa] down failed; run: dozo/docker/build.sh down"
  fi
  exit "$1"
}

# True for a step the timeout ended: exit 124 (TERM was enough), or 137 after the limit (timeout -k
# had to KILL a step that ignored TERM). A 137 before the limit is the step's own kill, not a timeout.
timed_out() { # rc elapsed limit
  [ "$1" -eq 124 ] || { [ "$1" -eq 137 ] && [ "$2" -ge "$3" ]; }
}

run_step() { # name cmd...
  local name="$1" log limit s rc el; shift
  log="$LOGS/$name.log"; limit=$(step_timeout "$name"); s=$(now)
  echo "[qa] >> $name (timeout ${limit}s, log ${log#"$ROOT"/})"
  with_timeout "$limit" "$@" >"$log" 2>&1; rc=$?
  el=$(( $(now) - s ))
  if [ "$rc" -eq 0 ]; then echo "[qa] << $name ok ${el}s"; return 0; fi
  if timed_out "$rc" "$el" "$limit"; then echo "[qa] << $name TIMEOUT after ${limit}s (raise DOZO_TIMEOUT_$(printf '%s' "$name" | tr a-z A-Z) if it is legitimate)"
  else echo "[qa] << $name FAIL exit $rc ${el}s"; fi
  echo "[qa] last 40 lines of $name:"; tail -n 40 "$log" | sed 's/^/[qa]   /'
  return "$rc"
}

# A stack already running under the project name is left running: a recreate-in-place by `up` is
# fine, but taking down what qa did not start is not. DOZO_STOP_TIMEOUT caps the stop wait of
# up/down: upstream gives the worker a 50 minute grace period, and a qa step that stops it blocks
# for that long unless the worker exits at once.
qa() {
  local t0 st was_up=0 reached_up=0 b="$ROOT/dozo/docker/build.sh"
  # One qa at a time per stage area, held for all steps: the build.sh steps it starts see
  # DOZO_LOCK_OWNER and do not lock again.
  stage_lock "$STAGE" || { echo "QA: FAIL (stage area in use) in 0s"; exit 2; }
  export DOZO_LOCK_OWNER=$$
  t0=$(now); mkdir -p "$LOGS"
  [ -z "$(docker ps -q --filter label=com.docker.compose.project=dozo --filter status=running 2>/dev/null)" ] || was_up=1
  export DOZO_STOP_TIMEOUT="${DOZO_STOP_TIMEOUT:-60}"
  [ "$was_up" -eq 0 ] || echo "[qa] project dozo is already running: qa will not take it down"
  # A subset of the steps, or an unbranded build, is not the full gate: the verdict line says so.
  local all="olc stage brand unit build up smoke" steps="${DOZO_QA_STEPS:-olc stage brand unit build up smoke}"
  [ "$(echo $steps)" = "$all" ] || partial "steps: $(echo $steps)"
  [ "${DOZO_SKIP_BRAND:-}" != 1 ] || partial "brand skipped (DOZO_SKIP_BRAND=1)"
  for st in $steps; do
    if [ "$st" = up ]; then reached_up=1; [ "$was_up" -eq 1 ] || QA_OWNS_STACK=1; fi
    case "$st" in
      olc|unit) run_step "$st" "$SELF" "$st" ;;
      *) run_step "$st" "$b" "$st" ;;
    esac || { fail "$st"; break; }
  done
  if [ "$reached_up" -eq 1 ] && [ "$was_up" -eq 0 ]; then run_step down "$b" down || fail down; QA_OWNS_STACK=0; fi
  QA_SECS=$(( $(now) - t0 ))
}

UNIT_OUT=""
on_exit() { wt_stop; stage_unlock; rm_run_containers; [ -z "$UNIT_OUT" ] || rm -f "$UNIT_OUT"; }
# Not a gate: no traps, no verdict, no Docker (sync.sh calls it for its fork-health count).
if [ "${1:-}" = upstream-edits ]; then shift; upstream_edits "$@"; exit $?; fi
trap 'on_signal 130' INT; trap 'on_signal 143' TERM; trap on_exit EXIT
case "${1:-}" in
  olc) T0=$(now); olc; V=OLC ;;
  qa) qa; V=QA ;;
  unit) T0=$(now); unit_tests; V=UNIT ;;
  *) echo "usage: $0 olc|qa|unit|upstream-edits <base-commit> [tree-ish]" >&2; exit 64 ;;
esac
SECS="${QA_SECS:-$(( $(now) - T0 ))}"
if [ ${#FAILS[@]} -eq 0 ]; then echo "$V: PASS${PARTIAL:+ (partial: $PARTIAL)} in ${SECS}s"
else echo "$V: FAIL ($(IFS=,; echo "${FAILS[*]}")) in ${SECS}s"; exit 2; fi
