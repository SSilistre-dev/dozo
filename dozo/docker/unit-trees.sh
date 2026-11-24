#!/usr/bin/env bash
# Lists the unit step's working copies in the dozo-qa-deps volume (/cache/trees/<key>) and whose
# they are, so a dead one can be removed on purpose. It only reads: the volume is mounted read-only
# and nothing is deleted; the command that removes one is printed for you to run.
# Usage: unit-trees.sh [list]. Exit 0, 64 usage, 2 when Docker or the Node image is missing.
# Columns: key, size, state, owner. State: live (the staged tree is still there), dead (it is gone),
# unknown (no owner note and not one of this repository's checkouts: most likely a checkout that is
# gone, but nothing proves it, so it is never offered for removal; the next unit run of a checkout
# writes its note).
set -uo pipefail
[ "${1:-list}" = list ] && [ "$#" -le 1 ] || { echo "usage: unit-trees.sh [list]" >&2; exit 64; }
VOLUME="${DOZO_QA_DEPS_VOLUME:-dozo-qa-deps}"
IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
command -v docker >/dev/null 2>&1 || { echo "unit-trees: docker is not installed" >&2; exit 2; }
out=$(docker run --rm -v "$VOLUME:/cache:ro" "$IMAGE" sh -c '
  cd /cache/trees 2>/dev/null || exit 0
  for d in */; do
    [ -d "$d" ] || continue
    k=${d%/}; o=""; [ -f "$k.owner" ] && o=$(head -n 1 "$k.owner")
    printf "%s\t%s\t%s\n" "$k" "$(du -sk "$k" | cut -f1)" "$o"
  done') || { echo "unit-trees: cannot read volume $VOLUME" >&2; exit 2; }
# A tree made before the owner note existed is still told apart when its key is that of one of this
# repository's checkouts (the key is the first 12 hex of the sha256 of the staged tree's path).
declare -A known=()
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  path="$wt/dozo/.stage/src"
  known[$(printf %s "$path" | sha256sum | cut -c1-12)]="$path"
done < <(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
dead=()
printf '%-14s %8s  %-8s %s\n' key size state owner
while IFS=$'\t' read -r key kb owner; do
  [ -n "$key" ] || continue
  [ -n "$owner" ] || owner="${known[$key]:-}"
  if [ -z "$owner" ]; then state=unknown
  elif [ -d "$owner" ]; then state=live
  else state=dead; dead+=("$key"); fi
  printf '%-14s %6s MB  %-8s %s\n' "$key" "$(( kb / 1024 ))" "$state" "${owner:--}"
done <<< "$out"
for key in "${dead[@]}"; do
  echo "remove: docker run --rm -v $VOLUME:/cache $IMAGE rm -rf /cache/trees/$key /cache/trees/$key.owner"
done
exit 0
