#!/usr/bin/env bash
# Offline checks of building here and sending to the host (deploy-ship.sh): a stub docker plays both
# this machine's Docker and the host's (each with its own folder of images), `remote` runs the
# host's side in the local shell as ssh would, and no ssh is started. The stub's `docker load` reads
# the archive the way the host's classic store does: a layer whose chain it already has is not read,
# any other must be in the archive. Run by `gate.sh olc`.
# Usage: deploy-ship.test.sh. Exit 0 all pass, 1 a case failed (each is printed).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/deploy-ship.sh"
DEPLOY="${DEPLOY_SH:-$HERE/deploy.sh}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dozo-ship-test.XXXXXX")
FAILED=0
bad() { FAILED=1; echo "[ship.test] FAIL: $*"; }
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
for t in jq zstd; do command -v "$t" >/dev/null || { echo "[ship.test] FAIL: $t is not installed"; exit 1; }; done

# The stub docker. DOCKER_SIDE=host acts on the host's images, anything else on this machine's.
# An image is a file: its id, its layers as JSON, its label, a creation counter. Layers are named
# by the build (FAKE layer names below) and their digest is that of the name, so two builds of the
# same step give the same layer, as a build cache does. Knobs: FAKE_HOST_PLATFORM, FAKE_HOST_STORE,
# FAKE_BUILD_FAIL (a build fails), FAKE_LOAD_WRONG (the host tags a different image).
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
side=${DOCKER_SIDE:-local}
root=$WORK/$side
mkdir -p "$root/images"
echo "$side $*" >>"$WORK/docker.calls"
file() { printf '%s/images/%s' "$root" "$(printf '%s' "$1" | tr '/:' '_~')"; }
dig() { printf '%s' "$1" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
# make <ref> <label> <layer names...>: the config holds the layers, the id is the config's digest.
make() {
  local ref=$1 label=$2 diffs=() n config; shift 2
  for n in "$@"; do diffs+=("sha256:$(dig "$n")"); printf '%s\n' "$n" >"$root/layer-$(dig "$n")"; done
  config=$(printf '%s\n' "${diffs[@]}" | jq -Rsc --arg l "$label" '{rootfs: {diff_ids: (split("\n") | map(select(. != "")))}, config: {Labels: {"dozo.deploy.build": $l}}}')
  printf '%s' "$config" >"$root/config-$(dig "$config")"
  n=$(($(cat "$root/counter" 2>/dev/null || echo 0) + 1)); echo "$n" >"$root/counter"
  printf 'sha256:%s\n%s\n%s\n%04d\n' "$(dig "$config")" "$(printf '%s' "$config" | jq -c '.rootfs.diff_ids')" "$label" "$n" >"$(file "$ref")"
  printf '%s\n' "$@" >"$(file "$ref").names"
}
case $1 in
  version) if [ "$side" = host ]; then echo "${FAKE_HOST_PLATFORM:-linux/amd64}"; else echo linux/amd64; fi ;;
  info)
    case $* in
      *DriverStatus*) [ "${FAKE_HOST_STORE:-classic}" = containerd ] && echo '[["driver-type","io.containerd.snapshotter.v1"]]' || echo '[["Backing Filesystem","extfs"]]' ;;
      *DockerRootDir*) echo "$root" ;;
    esac ;;
  images)
    shift
    label=""; format=""; repo=""
    while [ $# -gt 0 ]; do
      case $1 in --filter) label=${2#label=}; label=${label#*=}; shift 2 ;; --format) format=$2; shift 2 ;; *) repo=$1; shift ;; esac
    done
    for f in "$root/images/"*; do
      case $f in *.names | *'*') continue ;; esac
      ref=$(basename "$f" | tr '_~' '/:')
      [ "${ref%:*}" = "$repo" ] || continue
      [ -z "$label" ] || [ "$(sed -n 3p "$f")" = "$label" ] || continue
      case $format in
        *CreatedAt*) echo "2026-11-24 00:00:$(sed -n 4p "$f") +0000 UTC ${ref##*:}" ;;
        *) echo "$ref" ;;
      esac
    done ;;
  image)
    case $2 in
      inspect)
        shift 2; format=""
        [ "$1" != -f ] || { format=$2; shift 2; }
        for ref in "$@"; do
          f=$(file "$ref"); [ -f "$f" ] || { echo "No such image: $ref" >&2; exit 1; }
          case $format in
            *Labels*) sed -n 3p "$f" ;;
            '') ;;
            *) printf '%s\n' "$format" | sed "s#{{.Id}}#$(sed -n 1p "$f")#; s#{{json .RootFS.Layers}}#$(sed -n 2p "$f")#" ;;
          esac
        done ;;
      rm) rm -f "$(file "$3")" "$(file "$3").names" ;;
    esac ;;
  build)
    shift; tag=""; label=""; from=""
    while [ $# -gt 0 ]; do
      case $1 in -t) tag=$2; shift 2 ;; --label) label=${2#*=}; shift 2 ;; -f) [ "$2" != - ] || from=$(sed -n 's/^FROM //p'); shift 2 ;; *) shift ;; esac
    done
    [ -z "${FAKE_BUILD_FAIL:-}" ] || { echo "build step failed" >&2; exit 1; }
    t=${tag##*:}; t=${t%-base}
    case $tag in
      dozo/supervisor:*) make "$tag" "$label" debian supdeps "sup-$t" ;;
      rakazo/computer:*) make "$tag" "$label" ubuntu comp1 comp2 ;;
      dozo/app:*-base) make "$tag" "$label" node appdeps "app-$t" ;;
      # shellcheck disable=SC2046
      dozo/app:*) make "$tag" "$label" $(cat "$(file "$from").names") "theme-$t" ;;
    esac
    echo "sha256:x" ;;
  save)
    shift; out=$(mktemp -d "$WORK/save.XXXXXX"); mkdir -p "$out/blobs/sha256"; m='[]'
    for ref in "$@"; do
      f=$(file "$ref"); id=$(sed -n 1p "$f"); hex=${id#sha256:}
      cp "$root/config-$hex" "$out/blobs/sha256/$hex"
      paths='[]'
      for d in $(sed -n 2p "$f" | jq -r '.[]'); do
        cp "$root/layer-${d#sha256:}" "$out/blobs/sha256/${d#sha256:}"
        paths=$(printf '%s' "$paths" | jq -c --arg p "blobs/sha256/${d#sha256:}" '. + [$p]')
      done
      m=$(printf '%s' "$m" | jq -c --arg c "blobs/sha256/$hex" --arg r "$ref" --argjson l "$paths" '. + [{Config: $c, RepoTags: [$r], Layers: $l}]')
    done
    printf '%s' "$m" >"$out/manifest.json"; echo '{}' >"$out/index.json"
    tar -C "$out" -cf - . ;;
  load)
    in=$(mktemp -d "$WORK/load.XXXXXX")
    tar -x -C "$in" || { echo "unexpected EOF" >&2; exit 1; }
    (cd "$in" && find . -type f | sed 's#^\./##' | sort) >"$WORK/loaded.files"
    # The chains the host has: every prefix of every image's layers.
    for f in "$root/images/"*; do case $f in *.names | *'*') continue ;; esac; sed -n 2p "$f"; done |
      jq -c '. as $l | range(0; length) | $l[0:. + 1]' >"$WORK/chains"
    jq -c '.[]' "$in/manifest.json" | while read -r e; do
      config=$(printf '%s' "$e" | jq -r .Config)
      diffs=$(jq -c .rootfs.diff_ids "$in/$config")
      for i in $(seq 0 $(($(printf '%s' "$diffs" | jq length) - 1))); do
        chain=$(printf '%s' "$diffs" | jq -c ".[0:$i + 1]")
        grep -qxF "$chain" "$WORK/chains" && continue
        p=$(printf '%s' "$e" | jq -r ".Layers[$i]")
        [ -f "$in/$p" ] || { echo "open $p: no such file or directory" >&2; exit 1; }
        echo "$chain" >>"$WORK/chains"
      done
      ref=$(printf '%s' "$e" | jq -r '.RepoTags[0]')
      id="sha256:${config##*/}"
      [ -z "${FAKE_LOAD_WRONG:-}" ] || [ "${ref%:*}" != dozo/app ] || id=sha256:0000
      printf '%s\n%s\n\n9999\n' "$id" "$diffs" >"$(file "$ref")"
    done ;;
  *) echo "stub docker: $*" >&2; exit 1 ;;
esac
STUB
# df: the host's free space, FAKE_FREE_K kilobytes (default plenty).
cat >"$BIN/df" <<'STUB'
#!/bin/sh
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "fake 100 0 ${FAKE_FREE_K:-100000000} 0% /"
STUB
# A host PATH without zstd: the stubs and the few tools the host's question uses.
mkdir -p "$WORK/nozstd"
for t in bash sh grep sed awk head cat tr mkdir basename; do ln -s "$(command -v "$t")" "$WORK/nozstd/$t"; done
ln -s "$BIN/docker" "$WORK/nozstd/docker"; ln -s "$BIN/df" "$WORK/nozstd/df"
sed -i.bak "s#\$WORK#$WORK#g" "$BIN/docker" && rm -f "$BIN/docker.bak"
chmod +x "$BIN"/*

# The "deploy" process: the library with the options, helpers and ERR trap deploy.sh runs with.
# FAKE_CUT=<bytes>: the connection drops after that many bytes of what is sent.
cat >"$WORK/driver.sh" <<DRV
set -Eeuo pipefail
. "$LIB"
say() { printf '[deploy] %s\n' "\$*"; }
die() { printf '[deploy] FAIL: %s\n' "\$*" >&2; exit 2; }
trap 'die "line \$LINENO: \$BASH_COMMAND"' ERR
remote() {
  echo x >>"$WORK/ssh.calls"
  if [ -n "\${FAKE_CUT:-}" ] && case "\$*" in *"docker load"*) true ;; *) false ;; esac; then
    head -c "\$FAKE_CUT" | DOCKER_SIDE=host bash -c "\$*"
    return 255
  fi
  if [ -n "\${FAKE_HOST_NO_ZSTD:-}" ]; then DOCKER_SIDE=host PATH="$WORK/nozstd" bash -c "\$*"; return; fi
  DOCKER_SIDE=host bash -c "\$*"
}
stage="$WORK/stage"
ship_validate
eval "\$1"
DRV

# fresh: the host runs the images of commit "old0000000aa", built the same way (so it shares every
# layer that does not depend on the commit); this machine has nothing.
fresh() {
  rm -rf "$WORK/local" "$WORK/host" "$WORK/stage" "$WORK"/*.calls "$WORK/loaded.files" "$WORK"/save.* "$WORK"/load.*
  mkdir -p "$WORK/stage/src" && echo '{}' >"$WORK/stage/theme.json"
  for c in "dozo/supervisor:old0000000aa" "rakazo/computer:old0000000aa" "dozo/app:old0000000aa-base"; do
    DOCKER_SIDE=host PATH="$BIN:$PATH" docker build --label dozo.deploy.build=host -t "$c" . >/dev/null
  done
  printf 'FROM dozo/app:old0000000aa-base\n' | DOCKER_SIDE=host PATH="$BIN:$PATH" docker build -t dozo/app:old0000000aa -f - . >/dev/null
  DOCKER_SIDE=host PATH="$BIN:$PATH" docker image rm dozo/app:old0000000aa-base
  rm -f "$WORK/docker.calls"
}
run() {
  out=$(env -u DOZO_DEPLOY_BUILD PATH="$BIN:$PATH" "${@:2}" bash "$WORK/driver.sh" "$1" 2>&1)
  rc=$?
}
built() { grep -c '^local build' "$WORK/docker.calls" 2>/dev/null || true; }
loads() { grep -c '^host load' "$WORK/docker.calls" 2>/dev/null || true; }
host_id() { sed -n 1p "$WORK/host/images/$(printf '%s' "$1" | tr '/:' '_~')" 2>/dev/null; }
local_id() { sed -n 1p "$WORK/local/images/$(printf '%s' "$1" | tr '/:' '_~')" 2>/dev/null; }
noerr() { case $2 in *"FAIL: line"*) bad "$1: the ERR trap fired: $2" ;; esac; }
T=abcdef123456

# The whole path: built here, only the commit's own layers sent, the host's ids are the built ones.
fresh
run "ship_build $T; ship_send $T"
[ "$rc" = 0 ] || bad "happy: want exit 0, got $rc ($out)"
[ "$(built)" = 4 ] || bad "happy: want 4 builds here, got $(built)"
for r in dozo/supervisor rakazo/computer dozo/app; do
  [ -n "$(host_id "$r:$T")" ] && [ "$(host_id "$r:$T")" = "$(local_id "$r:$T")" ] ||
    bad "happy: the host's $r:$T is not the image built here ($(host_id "$r:$T") vs $(local_id "$r:$T"))"
done
sum() { { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
d() { printf 'blobs/sha256/%s' "$(printf '%s' "$1" | sum)"; }
for l in ubuntu comp1 comp2 debian supdeps node appdeps; do
  ! grep -qxF "$(d "$l")" "$WORK/loaded.files" || bad "happy: layer $l was sent though the host has it"
done
for l in "sup-$T" "app-$T" "theme-$T"; do
  grep -qxF "$(d "$l")" "$WORK/loaded.files" || bad "happy: layer $l was not sent"
done
case $out in *"ids of the three images match"*) ;; *) bad "happy: no line saying the ids match: $out" ;; esac
[ ! -e "$WORK/local/images/dozo_app~$T-base" ] || bad "happy: the base image was left here"
noerr happy "$out"

# A second run of the same commit: nothing is built and nothing is sent.
run "ship_build $T; ship_send $T"
[ "$rc" = 0 ] && [ "$(built)" = 4 ] && [ "$(loads)" = 1 ] || bad "repeat: built or loaded again (rc $rc, builds $(built), loads $(loads)): $out"
case $out in *"are there, nothing to build"*) ;; *) bad "repeat: no nothing-to-build line: $out" ;; esac

# A layer the host has under another chain is sent anyway: the host keeps layers by chain.
fresh
f="$WORK/host/images/dozo_supervisor~old0000000aa"
sed -i.bak "2s#.*#$(printf '%s' supdeps | sum | sed 's/.*/["sha256:&"]/')#" "$f" && rm -f "$f.bak"
run "ship_build $T; ship_send $T"
[ "$rc" = 0 ] || bad "other chain: want exit 0, got $rc ($out)"
grep -qxF "$(d supdeps)" "$WORK/loaded.files" || bad "other chain: supdeps was left out though no host image has it on debian"
grep -qxF "$(d debian)" "$WORK/loaded.files" || bad "other chain: debian was left out though only supdeps' own chain was replaced"

# An empty host (first deploy): every layer is sent and loads.
fresh
rm -f "$WORK/host/images/"*
run "ship_build $T; ship_send $T"
[ "$rc" = 0 ] || bad "empty host: want exit 0, got $rc ($out)"
for l in ubuntu debian node "theme-$T"; do grep -qxF "$(d "$l")" "$WORK/loaded.files" || bad "empty host: $l was not sent"; done

# Images of the commit left here by an earlier run are sent without building again.
fresh
run "ship_build $T"
rm -f "$WORK/docker.calls"
run "ship_build $T; ship_send $T"
[ "$rc" = 0 ] && [ "$(built)" = 0 ] || bad "reuse: want no build, got $(built) (rc $rc): $out"
case $out in *"from an earlier run"*) ;; *) bad "reuse: no line saying so: $out" ;; esac

# Refusals before anything is built: another CPU, containerd's store on the host, a bad setting.
fresh
run "ship_build $T" FAKE_HOST_PLATFORM=linux/arm64
[ "$rc" = 2 ] && [ "$(built)" = 0 ] || bad "arch: want exit 2 and no build, got $rc and $(built)"
case $out in *"host runs linux/arm64"*DOZO_DEPLOY_BUILD=host*) ;; *) bad "arch: message: $out" ;; esac
noerr arch "$out"
fresh
run "ship_build $T" FAKE_HOST_STORE=containerd
[ "$rc" = 2 ] && [ "$(built)" = 0 ] || bad "containerd: want exit 2 and no build, got $rc and $(built)"
case $out in *DOZO_DEPLOY_BUILD=host*) ;; *) bad "containerd: message does not name the setting: $out" ;; esac
run "ship_build $T" FAKE_HOST_NO_ZSTD=1
[ "$rc" = 2 ] && [ "$(built)" = 0 ] || bad "no zstd on the host: want exit 2 and no build, got $rc and $(built) ($out)"
case $out in *"zstd is not installed on the host"*) ;; *) bad "no zstd on the host: message: $out" ;; esac
# The host's Docker does not answer: an error, never an empty platform taken for an answer.
mv "$BIN/df" "$BIN/df.off"; printf '#!/bin/sh\nexit 1\n' >"$BIN/df"; chmod +x "$BIN/df"
run "ship_build $T"
mv "$BIN/df.off" "$BIN/df"
[ "$rc" = 2 ] && [ "$(built)" = 0 ] || bad "host df fails: want exit 2 and no build, got $rc and $(built) ($out)"
case $out in *"could not read the host's Docker"*) ;; *) bad "host df fails: message: $out" ;; esac
run "true" DOZO_DEPLOY_BUILD=remote
[ "$rc" = 64 ] || bad "bad setting: want exit 64, got $rc ($out)"
run "echo \$ship_mode" DOZO_DEPLOY_BUILD=host
[ "$out" = host ] || bad "DOZO_DEPLOY_BUILD=host: mode is $out"
run "echo \$ship_mode"
[ "$out" = local ] || bad "default: mode is $out, want local"

# A failed build stops the run; nothing reached the host but the read-only question.
fresh
run "ship_build $T" FAKE_BUILD_FAIL=1
[ "$rc" = 2 ] || bad "build fails: want exit 2, got $rc"
case $out in *"image build failed (nothing on the host was changed)"*) ;; *) bad "build fails: message: $out" ;; esac
! grep -q '^host \(load\|image rm\|build\)' "$WORK/docker.calls" || bad "build fails: the host was changed"
noerr build-fails "$out"

# A host without the room to load: refused before anything is sent.
fresh
run "ship_build $T; ship_send $T" FAKE_FREE_K=1000
[ "$rc" = 2 ] && [ "$(loads)" = 0 ] || bad "disk full: want exit 2 and no load, got $rc and $(loads)"
case $out in *"MiB free for Docker"*"nothing was sent"*) ;; *) bad "disk full: message: $out" ;; esac

# The connection drops halfway: the load fails, no tag of the commit is on the host, the next run
# sends again and succeeds.
fresh
run "ship_build $T"
run "ship_send $T" FAKE_CUT=300
[ "$rc" = 2 ] || bad "cut: want exit 2, got $rc ($out)"
case $out in *"sending or loading the images failed"*) ;; *) bad "cut: message: $out" ;; esac
[ -z "$(host_id "dozo/app:$T")" ] || bad "cut: the host has dozo/app:$T after a cut transfer"
noerr cut "$out"
run "ship_send $T"
[ "$rc" = 0 ] && [ "$(host_id "dozo/app:$T")" = "$(local_id "dozo/app:$T")" ] || bad "cut then retry: want a good load, got $rc: $out"

# A damaged archive: zstd refuses it and nothing is tagged.
fresh
run "ship_build $T"
cat >"$WORK/damage.sh" <<'EOF'
zstd() { if [ "${1:-}" = -q ]; then command zstd "$@" | { head -c 200; printf 'garbage'; cat >/dev/null; }; else command zstd "$@"; fi; }
EOF
run ". $WORK/damage.sh; ship_send $T"
[ "$rc" = 2 ] && [ -z "$(host_id "dozo/app:$T")" ] || bad "damaged: want exit 2 and no tag, got $rc: $out"

# The host ends up with another image under the tag: the run fails before any switch.
fresh
run "ship_build $T; ship_send $T" FAKE_LOAD_WRONG=1
[ "$rc" = 2 ] || bad "wrong id: want exit 2, got $rc ($out)"
case $out in *"dozo/app:$T is not the image built here"*) ;; *) bad "wrong id: message: $out" ;; esac
noerr wrong-id "$out"

# Cleanup here: only this script's tags, the newest three commits kept, the current one always.
fresh
for t in 111111111111 222222222222 333333333333 444444444444; do run "ship_build $t"; done
# Two images this script did not make: another tag, and its tag form with another label.
i="$WORK/local/images"
sed '3s/.*//' "$i/dozo_app~444444444444" >"$i/dozo_app~local"
sed '3s/.*/other/' "$i/dozo_app~444444444444" >"$i/dozo_app~555555555555"
run "ship_build $T"
left=$(ls "$WORK/local/images" | grep -v '\.names$' | sort | tr '\n' ' ')
for gone in 111111111111 222222222222; do
  case $left in *"$gone"*) bad "cleanup: $gone was kept: $left" ;; esac
done
for kept in 333333333333 444444444444 "$T" "dozo_app~local" 555555555555; do
  case $left in *"$kept"*) ;; *) bad "cleanup: $kept was removed: $left" ;; esac
done
! grep -q 'prune' "$WORK/docker.calls" || bad "cleanup: a prune was run"

# deploy.sh: the setting is refused before any ssh; the build here comes before the lock and the
# sending after it; building on the host stays one setting away.
cat >"$WORK/deploy.conf" <<CONF
DOZO_DEPLOY_SSH=host
DOZO_DEPLOY_DOMAIN=dozo.example
DOKPLOY_URL=https://panel.example
DOKPLOY_COMPOSE_ID=x
DOKPLOY_API_KEY=k
CONF
for t in git rsync curl jq; do [ -e "$BIN/$t" ] || ln -s "$(command -v "$t" || echo /bin/true)" "$BIN/$t"; done
printf '#!/bin/sh\necho x >>"%s/real-ssh.calls"\nexit 255\n' "$WORK" >"$BIN/ssh" && chmod +x "$BIN/ssh"
out=$(env PATH="$BIN:$PATH" DOZO_DEPLOY_CONF="$WORK/deploy.conf" DOZO_DEPLOY_BUILD=both bash "$DEPLOY" 2>&1)
rc=$?
[ "$rc" = 64 ] || bad "deploy.sh DOZO_DEPLOY_BUILD=both: want exit 64, got $rc ($out)"
[ ! -e "$WORK/real-ssh.calls" ] || bad "deploy.sh: ssh was started before the setting was refused"
line() { grep -n "$1" "$DEPLOY" | head -n 1 | cut -d: -f1; }
b=$(line '|| ship_build "\$tag"') l=$(line '^lock_take "deploy-') s=$(line '  ship_send "\$tag"') r=$(line '^run_tag "\$tag" "\$merged"')
[ -n "$b" ] && [ -n "$l" ] && [ -n "$s" ] && [ -n "$r" ] && [ "$b" -lt "$l" ] && [ "$l" -lt "$s" ] && [ "$s" -lt "$r" ] ||
  bad "deploy.sh: want build here < lock < send < run_tag, got lines ${b:-?} ${l:-?} ${s:-?} ${r:-?}"

exit "$FAILED"
