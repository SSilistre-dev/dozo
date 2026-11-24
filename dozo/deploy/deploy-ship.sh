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
  ship_facts=$(remote bash -s <<<"$(ship_facts_script)") || die "could not read the host's Docker (ssh or docker failed)"
  [ "$(printf '%s\n' "$ship_facts" | tail -n 1)" = done ] || die "the host's answer about its images was cut short"
  case $(ship_fact free) in '' | *[!0-9]*) die "the host did not say how much room its Docker has" ;; esac
}
ship_fact() { printf '%s\n' "$ship_facts" | sed -n "s/^$1 //p" | head -n 1; }
# ship_host_has <tag>: the host holds all three images of the tag.
ship_host_has() {
  local repo
  for repo in $ship_repos; do
    printf '%s\n' "$ship_facts" | grep -q "^image $repo:$1 " || return 1
  done
}
ship_local_has() {
  local repo
  for repo in $ship_repos; do
    [ "$(docker image inspect -f '{{index .Config.Labels "dozo.deploy.build"}}' "$repo:$1" 2>/dev/null)" = local ] || return 1
  done
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
  here_platform=$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}') || die "the local Docker does not answer"
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
  if ship_local_has "$tag"; then
    say "the images of $tag are here from an earlier run, not built again"
    return 0
  fi
  say "build the images here ($want)"
  base=$(date +%s)
  # Chained with &&: `set -e` does not apply inside a command whose status is tested.
  local flags=(-q --platform "$want" --provenance=false --label "$ship_label")
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
        [ "$(docker image inspect -f '{{index .Config.Labels "dozo.deploy.build"}}' "$repo:$old" 2>/dev/null)" = local ] &&
          docker image rm "$repo:$old" >/dev/null 2>&1
      done
    done || true
}

# ship_plan <archive dir> <host facts>: prints the archive's layer files that may stay behind. A file
# stays only if every image that uses it has, up to and including it, the same layers as an image on
# the host. Reads manifest.json and each image's config (rootfs.diff_ids) from the archive.
ship_plan() {
  local dir=$1 entries host
  host=$(printf '%s\n' "$2" | sed -n 's/^image [^ ]* [^ ]* //p' | jq -sc '.')
  entries=$(jq -c '.[]' "$dir/manifest.json" | while read -r entry; do
    jq -c --argjson e "$entry" '{layers: $e.Layers, diffs: .rootfs.diff_ids}' \
      "$dir/$(printf '%s' "$entry" | jq -r '.Config')"
  done | jq -sc '.')
  jq -nr --argjson host "$host" --argjson entries "$entries" '
    def present($d; $i): any($host[]; .[0:$i + 1] == $d[0:$i + 1]);
    [ $entries[] | . as $e | range(0; $e.layers | length) | {path: $e.layers[.], skip: present($e.diffs; .)} ]
    | group_by(.path) | map(select(all(.skip)) | .[0].path) | .[]'
}

# ship_expected <archive dir>: `<repo>:<tag> sha256:<config digest> <layers as JSON>` for each image.
ship_expected() {
  local dir=$1
  jq -c '.[]' "$dir/manifest.json" | while read -r entry; do
    local config ref
    config=$(printf '%s' "$entry" | jq -r '.Config')
    ref=$(printf '%s' "$entry" | jq -r '.RepoTags[0]')
    printf '%s sha256:%s %s\n' "$ref" "${config##*/}" "$(jq -c '.rootfs.diff_ids' "$dir/$config")"
  done
}

# ship_send <tag>: under the lock. Sends the images the host lacks and checks what it then holds.
# A failure here leaves the running app untouched: nothing is replaced until the ids match, a
# load cut short adds no tag, and the next run sends again over whatever a partial load left.
ship_send() {
  local tag=$1 dir list keep need archive size free repo want got base
  [ -z "$ship_skip" ] || return 0
  ship_host_facts
  if ship_host_has "$tag"; then
    say "host: the images of $tag are there, nothing to send"
    return 0
  fi
  dir=$stage/images
  rm -rf "$dir"
  mkdir -p "$dir"
  # shellcheck disable=SC2086
  docker save $(for repo in $ship_repos; do printf '%s:%s ' "$repo" "$tag"; done) | tar -x -C "$dir" ||
    die "could not save the images of $tag"
  keep=$(ship_plan "$dir" "$ship_facts") || die "could not read the saved images"
  list=$stage/images.list
  (cd "$dir" && find . -type f | sed 's#^\./##' | sort) | grep -vxF -f <(printf '%s\n' "$keep") >"$list" || true
  size=$(cd "$dir" && tr '\n' '\0' <"$list" | xargs -0 wc -c | awk '$2 != "total" { s += $1 } END { print s + 0 }')
  # The load writes the archive's layers once to a temporary folder and once to the store.
  free=$(ship_fact free)
  need=$((2 * size + 1073741824))
  [ "${free:-0}" -ge "$need" ] ||
    die "the host has $((${free:-0} / 1048576)) MiB free for Docker and loading these images needs $((need / 1048576)) MiB (nothing was sent)"
  base=$(date +%s)
  archive=$stage/images.tar.zst
  (cd "$dir" && tar -cf - -T "$list") | zstd -q -T0 -3 >"$archive" || die "could not pack the images of $tag"
  say "host: sending $(($(wc -c <"$archive") / 1048576)) MiB ($((size / 1048576)) MiB unpacked; $(printf '%s\n' "$keep" | grep -c . || true) layers are there already)"
  remote "bash -c 'set -o pipefail; zstd -dcq | docker load -q >/dev/null'" <"$archive" ||
    die "sending or loading the images failed (nothing on the host was replaced; the next deploy sends them again)"
  say "host: packed, sent and loaded in $(($(date +%s) - base))s"
  ship_host_facts
  while read -r repo want; do
    got=$(printf '%s\n' "$ship_facts" | sed -n "s#^image $repo ##p")
    [ "$got" = "$want" ] ||
      die "the host's $repo is not the image built here (wanted $want, found ${got:-nothing}); nothing was replaced"
  done < <(ship_expected "$dir")
  say "host: the ids of the three images match the ones built here"
  rm -rf "$dir" "$list" "$archive"
}
