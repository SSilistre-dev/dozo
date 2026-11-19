#!/usr/bin/env bash
# Inside the dozo-olcum image, started by olcum.sh: /cache/in holds the repository's files (git's
# list, unbranded), /stage the branded staged tree. Both are synced into the dozo-olcum-deps volume,
# their dependencies installed when a lockfile changed, then collect.mjs measures into /out.
set -euo pipefail
export LC_ALL=C CI=1 COREPACK_HOME=/cache/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 TURBO_TELEMETRY_DISABLED=1

# Incremental copy (as gate.sh unit does): a manifest of path, size and mtime per file on both sides;
# files only in the copy go, new or changed ones are copied, every node_modules, data/ and .git stay.
sync_tree() {
  local from="$1" to="$2"
  mkdir -p "$to"
  manifest() { (cd "$1" && find . -name node_modules -prune -o -path ./data -prune -o -path ./.git -prune -o \( -type f -o -type l \) -printf "%p\t%s\t%Ts\0" | sort -z); }
  manifest "$from" > /tmp/from.m; manifest "$to" > /tmp/to.m
  cut -z -f1 /tmp/from.m > /tmp/from.p; cut -z -f1 /tmp/to.m > /tmp/to.p
  (cd "$to" && comm -z -13 /tmp/from.p /tmp/to.p | xargs -0 -r rm -f)
  comm -z -23 /tmp/from.m /tmp/to.m | cut -z -f1 > /tmp/changed
  if [ -s /tmp/changed ]; then tar -C "$from" --null -T /tmp/changed -cf - | tar -C "$to" -xf -; fi
  echo "[olcum] sync $to: $(tr -cd '\0' < /tmp/changed | wc -c) file(s) copied"
}

# Installs a tree's dependencies when its lockfile changed, adds the coverage provider at the tree's
# Vitest version (inside the volume only) and generates the database client the api tests load.
deps() {
  local dir="$1" want v
  cd "$dir"
  want=$(sha256sum pnpm-lock.yaml | cut -d" " -f1)
  if [ "$(cat node_modules/.dozo-olcum 2>/dev/null)" != "$want" ]; then
    echo "[olcum] deps $dir: installing"
    rm -f node_modules/.dozo-olcum
    pnpm install --frozen-lockfile --store-dir /cache/store --loglevel=error
    v=$(node -p 'require("./node_modules/vitest/package.json").version')
    pnpm add -Dw "@vitest/coverage-v8@$v" --store-dir /cache/store --loglevel=error
    echo "$want" > node_modules/.dozo-olcum
  fi
  rm -rf packages/db/src/generated
  pnpm --filter @rakazo/db generate > /tmp/generate.log 2>&1 || { cat /tmp/generate.log; exit 1; }
}

mkdir -p /cache/store
sync_tree /cache/in /cache/src
sync_tree /stage /cache/w
corepack enable
# `pnpm checks` and some upstream tests ask git for the file list: one throwaway commit of the tree.
(cd /cache/src && rm -rf .git && git init -q && git add -A &&
  git -c user.name=olcum -c user.email=olcum@localhost commit -qm olcum)
deps /cache/src
deps /cache/w
cd /cache/src
node dozo/metrics/collect.mjs
chown -R "$HOST_UID" /out
