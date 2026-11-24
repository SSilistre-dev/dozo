#!/usr/bin/env bash
# The images built on the deploying machine instead of the host (DOZO_DEPLOY_BUILD=local, the
# default), so a build never competes with the running app for the host's memory and CPU. They are
# built here for the host's platform, sent over ssh with only the layers the host does not already
# hold, loaded, and their ids checked against what was built before anything on the host is
# replaced. Sourced by deploy.sh; needs say, die, `remote` and $stage. Tested offline with `remote`
# pointed at the local shell and stub docker: dozo/deploy/deploy-ship.test.sh; against the host's
# Docker version in a throwaway docker-in-docker: dozo/deploy/deploy-ship.dind.sh. Settings and what
# it prints: dozo/deploy/README.md, Where the images are built.
#
# Only the missing layers: `docker load` on a host with the classic image store looks each layer up
# by its chain (the layer and every layer below it) and reads the file of a layer only when that
# chain is missing. So a layer file is left out of the archive exactly when every image in it that
# uses the file has the same layers up to it as an image already on the host. The id of an image in
# that store is the digest of its config, so an id equal to the config the archive named is the
# image that was built here, byte for byte.

ship_mode=local
# dozo/app last: it is tagged last, so finding it means the set is whole.
ship_repos="dozo/supervisor rakazo/computer dozo/app"
# Local images of this many commits stay for a quick redeploy; older ones are removed (only those
# this script built: they carry the label below).
ship_keep=3
ship_label=dozo.deploy.build=local
ship_skip=""
# A capture that may fail starts with `trap - ERR`: bash 3.2 (macOS) runs the ERR trap inside a
# command substitution even when the caller tests its status, which would print a second, wrong
# failure line before the caller's own.

ship_validate() {
  ship_mode=${DOZO_DEPLOY_BUILD:-local}
  case $ship_mode in
    local | host) ;;
    *)
      printf '[deploy] FAIL: DOZO_DEPLOY_BUILD must be local or host, got "%s"\n' "$ship_mode" >&2
      exit 64
      ;;
  esac
}

# The host side, read only. Prints `platform <os>/<arch>`, `store classic|containerd`,
# `free <bytes in Docker's folder>`, `zstd yes|no`, then `image <repo>:<tag> <id> <layers as JSON>` for every tag of
# the three images, and last `done`, so a reply cut short is never read as a host without images.
ship_facts_script() {
  cat <<'HOST'
set -euo pipefail
# Assigned first: a failing command inside `echo "$(...)"` would print an empty value and go on.
platform=$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')
status=$(docker info -f '{{json .DriverStatus}}')
root=$(docker info -f '{{.DockerRootDir}}')
free=$(df -Pk "$root" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')
echo "platform $platform"
case $status in *io.containerd.snapshotter*) echo "store containerd" ;; *) echo "store classic" ;; esac
command -v zstd >/dev/null 2>&1 && echo "zstd yes" || echo "zstd no"
echo "free $free"
for repo in dozo/supervisor rakazo/computer dozo/app; do
  for ref in $(docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' || true); do
    docker image inspect -f "image $ref {{.Id}} {{json .RootFS.Layers}}" "$ref"
  done
done
echo done
HOST
}

ship_facts=""
ship_host_facts() {
  ship_facts=$(trap - ERR; remote bash -s <<<"$(ship_facts_script)") || die "could not read the host's Docker (ssh or docker failed)"
  [ "$(tail -n 1 <<<"$ship_facts")" = done ] || die "the host's answer about its images was cut short"
  case $(ship_fact free) in '' | *[!0-9]*) die "the host did not say how much room its Docker has" ;; esac
}
# From a here-string, never `printf | grep -q`: a reader that stops at the first match ends the
# pipe early, and with pipefail the writer's SIGPIPE turns a match into a miss.
ship_fact() { sed -n "/^$1 /{s/^$1 //p;q;}" <<<"$ship_facts"; }
# ship_host_has <tag>: the host holds all three images of the tag. The host holds a tag only from a
# build there, or from a load here whose ids were then checked: `docker load` tags an image after
# all of its layers are in, each checked against its digest, and ship_send removes the tags again
# when the check fails. A half or damaged load leaves no tag.
ship_host_has() {
  local repo
  for repo in $ship_repos; do
    if ! grep -q "^image $repo:$1 " <<<"$ship_facts"; then return 1; fi
  done
}
# ship_local_has <tag>: this machine holds the three images of the tag, built by this script from
# the same staged tree ($ship_input). The tag alone would also match a build of another tree for
# the same commit (another brand input, an older version of this script's stage).
ship_local_has() {
  local repo
  for repo in $ship_repos; do
    if [ "$(trap - ERR; docker image inspect -f '{{index .Config.Labels "dozo.deploy.build"}} {{index .Config.Labels "dozo.deploy.input"}}' \
      "$repo:$1" 2>/dev/null)" != "local $ship_input" ]; then
      return 1
    fi
  done
}

# The digest of everything the build reads: every file of the staged, branded tree and the theme,
# with its path. Sorted with LC_ALL=C so the order never depends on the locale.
ship_input=""
ship_input_sum() {
  local sum=(sha256sum)
  command -v sha256sum >/dev/null || sum=(shasum -a 256)
  (cd "$stage" && find src theme.json -type f -print0 | LC_ALL=C sort -z | xargs -0 "${sum[@]}") |
    "${sum[@]}" | cut -d' ' -f1
}

# ship_order_check <running tag> <tag>: under the lock, before anything on the host changes.
# Refuses to put a commit over a running one it does not contain: a deploy that took longer to
# build must not replace a newer release another deploy has put in the meantime. Nothing running
# (a first deploy) and the same commit pass; a running commit this checkout does not know stops
# the run, since the order cannot be told. `rollback` is the way back on purpose and is not checked.
# Needs $repo.
ship_order_check() {
  local running=$1 tag=$2 commit
  [ -n "$running" ] && [ "$running" != "$tag" ] || return 0
  commit=$(trap - ERR; git -C "$repo" rev-parse --verify --quiet "$running^{commit}") ||
    die "the host runs $running, which this checkout does not know: fetch, then deploy again (nothing was replaced; to go back on purpose: deploy.sh rollback <tag>)"
  git -C "$repo" merge-base --is-ancestor "$commit" "$tag" ||
    die "the host already runs $running, which $tag does not contain (a newer or another line of work); nothing was replaced. Deploy a commit that contains it, or go back on purpose with deploy.sh rollback $tag"
}

# ship_build <tag>: before the lock (nothing on the host changes). Builds the three images here,
# unless the host already has them (as a deploy on the host found them: nothing to build or send)
# or this machine still has them from an earlier run of the same commit.
ship_build() {
  local tag=$1 want here_platform store base
  ship_host_facts
  if ship_host_has "$tag"; then
    say "host: the images of $tag are there, nothing to build"
    ship_skip=1
    return 0
  fi
  want=$(ship_fact platform) store=$(ship_fact store)
  here_platform=$(trap - ERR; docker version -f '{{.Server.Os}}/{{.Server.Arch}}') || die "the local Docker does not answer"
  # Building for another CPU runs every step under emulation: slow, and never tried for this
  # stack. Building on the host stays available for that case.
  [ "$here_platform" = "$want" ] ||
    die "this machine builds $here_platform images and the host runs $want: deploy from a $want machine, or set DOZO_DEPLOY_BUILD=host"
  [ "$store" = classic ] ||
    die "the host keeps its images in containerd's store, where sending only the missing layers is untested: set DOZO_DEPLOY_BUILD=host"
  # zstd, not gzip: the layers are often compressed already, which zstd passes in a second and
  # gzip spends a minute on; and it is many times faster on layers that are not.
  command -v zstd >/dev/null || die "zstd is not installed here (needed to send the images), or set DOZO_DEPLOY_BUILD=host"
  [ "$(ship_fact zstd)" = yes ] || die "zstd is not installed on the host (needed to receive the images), or set DOZO_DEPLOY_BUILD=host"
  ship_input=$(trap - ERR; ship_input_sum) && [ -n "$ship_input" ] || die "could not read the staged tree"
  if ship_local_has "$tag"; then
    say "the images of $tag are here from an earlier run, not built again"
    return 0
  fi
  say "build the images here ($want)"
  base=$(date +%s)
  # Chained with &&: `set -e` does not apply inside a command whose status is tested.
  local flags=(-q --platform "$want" --provenance=false --label "$ship_label" --label "dozo.deploy.input=$ship_input")
  {
    (cd "$stage/src" &&
      docker build "${flags[@]}" -f infra/sandboxes/supervisor/Dockerfile -t "dozo/supervisor:$tag" . &&
      docker build "${flags[@]}" -t "rakazo/computer:$tag" infra/sandboxes/computer &&
      docker build "${flags[@]}" --build-arg "GIT_SHA=$tag" -f infra/compose/Dockerfile -t "dozo/app:$tag-base" .) &&
      # The theme ships inside the image, so a tag is one artefact and a rollback restores it too.
      mkdir -p "$stage/theme" && cp "$stage/theme.json" "$stage/theme/theme.json" &&
      printf 'FROM dozo/app:%s-base\nCOPY theme.json /theme/theme.json\n' "$tag" |
      docker build "${flags[@]}" -t "dozo/app:$tag" -f - "$stage/theme" &&
      docker image rm "dozo/app:$tag-base"
  } >/dev/null || die "the image build failed (nothing on the host was changed)"
  say "built in $(($(date +%s) - base))s"
  ship_prune_local "$tag"
}

# ship_prune_local <tag>: removes the tags of this script's images older than the newest
# $ship_keep commits, never <tag>. Only tags it gives (twelve hex digits) on images with its label.
ship_prune_local() {
  local tag=$1 old repo
  docker images --filter "label=$ship_label" --format '{{.CreatedAt}} {{.Tag}}' dozo/app 2>/dev/null |
    sort -r | awk '{ print $NF }' | grep -E '^[0-9a-f]{12}$' | grep -vxF "$tag" |
    tail -n +"$ship_keep" | while read -r old; do
      for repo in $ship_repos; do
        [ "$(trap - ERR; docker image inspect -f '{{index .Config.Labels "dozo.deploy.build"}}' "$repo:$old" 2>/dev/null)" = local ] &&
          docker image rm "$repo:$old" >/dev/null 2>&1 || true
      done
    done || true
}

# ship_plan <archive dir> <host facts>: prints the archive's layer files that may stay behind. A file
# stays only if every image that uses it has, up to and including it, the same layers as an image on
# the host. Reads manifest.json and each image's config (rootfs.diff_ids) from the archive.
ship_plan() {
  local dir=$1 entries host
  host=$(sed -n 's/^image [^ ]* [^ ]* //p' <<<"$2" | jq -sc '.') || return 1
  entries=$(ship_entries "$dir") || return 1
  jq -nr --argjson host "$host" --argjson entries "$entries" '
    def present($d; $i): any($host[]; .[0:$i + 1] == $d[0:$i + 1]);
    [ $entries[] | . as $e | range(0; $e.layers | length) | {path: $e.layers[.], skip: present($e.diffs; .)} ]
    | group_by(.path) | map(select(all(.skip)) | .[0].path) | .[]'
}

# ship_entries <archive dir>: a JSON array, one {ref, config, layers, diffs} per image of
# manifest.json with the layers its config lists. Fails on anything it cannot read, and unless
# it finds the three images with as many layer files as layers.
ship_entries() {
  local dir=$1 entry config out=""
  jq -e 'type == "array"' "$dir/manifest.json" >/dev/null 2>&1 || return 1
  while read -r entry; do
    config=$(jq -r '.Config' <<<"$entry") || return 1
    out+=$(jq -c --argjson e "$entry" --arg c "${config##*/}" \
      '{ref: $e.RepoTags[0], config: $c, layers: $e.Layers, diffs: .rootfs.diff_ids}' "$dir/$config") || return 1
    out+=$'\n'
  done < <(jq -c '.[]' "$dir/manifest.json")
  jq -sce 'length == 3 and all(.[]; (.layers | length) == (.diffs | length) and (.ref | type) == "string")' \
    <<<"$out" >/dev/null || return 1
  jq -sc '.' <<<"$out"
}

# ship_expected <archive dir>: `<repo>:<tag> sha256:<config digest> <layers as JSON>` for each image.
ship_expected() {
  local entries
  entries=$(ship_entries "$1") || return 1
  jq -r '.[] | "\(.ref) sha256:\(.config) \(.diffs | tojson)"' <<<"$entries"
}

# ship_send <tag>: under the lock. Sends the images the host lacks and checks what it then holds.
# A failure here leaves the running app untouched: nothing is replaced until the ids match, a
# load cut short adds no tag, and the next run sends again over whatever a partial load left.
ship_send() {
  local tag=$1 dir list keep need archive size free repo want got base
  # Asked again under the lock: another deploy may have removed or added the images since.
  ship_host_facts
  if ship_host_has "$tag"; then
    [ -n "$ship_skip" ] || say "host: the images of $tag are there, nothing to send"
    return 0
  fi
  [ -z "$ship_skip" ] ||
    die "the images of $tag are no longer on the host (removed since this run asked); nothing was replaced, deploy again"
  dir=$stage/images
  rm -rf "$dir"
  mkdir -p "$dir"
  # shellcheck disable=SC2086
  docker save $(for repo in $ship_repos; do printf '%s:%s ' "$repo" "$tag"; done) | tar -x -C "$dir" ||
    die "could not save the images of $tag"
  keep=$(trap - ERR; ship_plan "$dir" "$ship_facts") || die "could not read the saved images"
  list=$stage/images.list
  (cd "$dir" && find . -type f | sed 's#^\./##' | sort) | grep -vxF -f <(printf '%s\n' "$keep") >"$list" || true
  size=$(cd "$dir" && tr '\n' '\0' <"$list" | xargs -0 wc -c | awk '$2 != "total" { s += $1 } END { print s + 0 }')
  # The load writes the archive once to a temporary folder, and the store holds its layers
  # unpacked: an estimate, taken as three times their packed size, plus 1 GiB.
  free=$(ship_fact free)
  need=$((4 * size + 1073741824))
  [ "${free:-0}" -ge "$need" ] ||
    die "the host has $((${free:-0} / 1048576)) MiB free for Docker and loading these images needs about $((need / 1048576)) MiB, an estimate with the layers unpacked (nothing was sent)"
  base=$(date +%s)
  archive=$stage/images.tar.zst
  (cd "$dir" && tar -cf - -T "$list") | zstd -q -T0 -3 >"$archive" || die "could not pack the images of $tag"
  say "host: sending $(($(wc -c <"$archive") / 1048576)) MiB ($((size / 1048576)) MiB before packing; $(printf '%s\n' "$keep" | grep -c . || true) layers are there already)"
  remote "bash -c 'set -o pipefail; zstd -dcq | docker load -q >/dev/null'" <"$archive" ||
    die "sending or loading the images failed (nothing on the host was replaced; the next deploy sends them again). If it fails the same way each time, the host's Docker may refuse an archive without the layers it has: set DOZO_DEPLOY_BUILD=host"
  say "host: packed, sent and loaded in $(($(date +%s) - base))s"
  # Read whole first: from a process substitution its failure, or no line at all, would go unseen
  # and leave nothing to compare.
  local expected
  expected=$(trap - ERR; ship_expected "$dir") && [ "$(trap - ERR; grep -c . <<<"$expected")" = 3 ] ||
    die "could not read the three images from the saved archive to check them; nothing was replaced"
  ship_host_facts
  while read -r repo want; do
    got=$(sed -n "s#^image $repo ##p" <<<"$ship_facts")
    if [ "$got" != "$want" ]; then
      # Untagged again, so no later run takes them for checked images. A tag a container still
      # uses is refused by Docker and named here.
      # shellcheck disable=SC2046
      remote "docker image rm $(for r in $ship_repos; do printf '%s:%s ' "$r" "$tag"; done) >/dev/null 2>&1" ||
        say "WARNING: could not remove every tag of $tag on the host; remove them before deploying $tag again"
      die "the host's $repo is not the image built here (wanted $want, found ${got:-nothing}); its tags of $tag were removed and nothing was replaced"
    fi
  done <<<"$expected"
  say "host: the ids of the three images match the ones built here"
  rm -rf "$dir" "$list" "$archive"
}
