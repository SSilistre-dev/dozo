#!/usr/bin/env bash
# Builds the Dozo iOS app for the simulator. It runs on the host: Docker cannot build an iOS app.
# The app is upstream's Expo app (apps/mobile), built from the branded staged tree, never from the
# source tree. No Apple account, signing, device or cloud build is involved (README.md).
# Usage: dozo/mobile/build.sh check|sim|clean
#   check   stage and brand, install the JavaScript dependencies, resolve the Expo config and fail
#           unless it carries the Dozo values and nothing of upstream's accounts
#   sim     check, then prebuild, pod install, a Release build for the simulator, and install and
#           launch it on a simulator this script creates ("Dozo build")
#   clean   delete that simulator and the build output (.build); the toolchain stays
# Node, pnpm, CocoaPods and every cache go into dozo/mobile/.toolchain (git-ignored), the staged
# tree, node_modules, the Xcode project and DerivedData into dozo/mobile/.build. HOME points into
# the toolchain while they run, so nothing is written to ~/.npm, ~/.cache, ~/.cocoapods, ~/.expo,
# ~/Library/Developer/Xcode/DerivedData, a shell profile, Homebrew or a global npm or gem directory.
# Needs Xcode with an iOS simulator runtime, Docker (to stage and brand) and network access.
# DOZO_MOBILE_API_URL: the server the app opens with (default https://dozo.ssilistre.dev).
# DOZO_MOBILE_DEVICE: the simulator device type (default "iPhone 17").
# Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
trap 'rc=$?; [ $rc -eq 0 ] || [ $rc -eq 64 ] || exit 2' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TC="$HERE/.toolchain"
OUT="$HERE/.build"
# The versions upstream builds with (apps/mobile/eas.json, the root packageManager field).
NODE_VERSION=24.22.2
NODE_SHA256_arm64=1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115
NODE_SHA256_x64=6965578fd823e72c1b5387f5ab84cb25368f886e02eb8779e6f0fce6b91c27b7
PNPM_VERSION=12.18.0
COCOAPODS_VERSION=1.16.2
API_URL="${DOZO_MOBILE_API_URL:-https://dozo.ssilistre.dev}"
DEVICE_TYPE="${DOZO_MOBILE_DEVICE:-iPhone 17}"
DEVICE_NAME="Dozo build"
MIN_FREE_GB=15
# A stage of this build's own: the shared dozo/.stage belongs to the Docker stack.
export DOZO_STAGE_DIR="$OUT/stage"
SRC="$DOZO_STAGE_DIR/src"
APP="$SRC/apps/mobile"
HOST_RUBY="$(command -v ruby || true)"

say() { echo "[mobile] $*"; }
die() { echo "[mobile] FAILED: $1" >&2; exit "${2:-2}"; }
timed() { local t=$SECONDS; "$@"; say "$1: $((SECONDS - t))s"; }

preflight() {
  [ "$(uname -s)" = Darwin ] || die "this builds an iOS app: run it on a Mac"
  local free; free=$(df -g "$HERE" | awk 'NR == 2 { print $4 }')
  [ "$free" -ge "$MIN_FREE_GB" ] || die "only ${free} GB free: the build needs $MIN_FREE_GB GB"
  say "free disk: ${free} GB"
}

# Docker's context and credentials live in the real home: stage and brand before HOME moves.
stage() {
  "$ROOT/dozo/docker/build.sh" stage
  "$ROOT/dozo/docker/build.sh" brand
}

# From here on every tool sees the toolchain as its home and only the toolchain and the system on
# PATH, so a cache it keeps "under ~" lands in .toolchain and no host node, pod or gem is picked up.
seal() {
  mkdir -p "$TC/home" "$TC/cache"
  export HOME="$TC/home"
  export PATH="$TC/node/bin:$TC/pnpm/bin:$TC/gems/bin:$TC/ruby/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export npm_config_cache="$TC/cache/npm"
  export npm_config_update_notifier=false COREPACK_HOME="$TC/cache/corepack"
  export XDG_CACHE_HOME="$TC/cache/xdg" XDG_DATA_HOME="$TC/home/.local/share"
  export XDG_STATE_HOME="$TC/home/.local/state" XDG_CONFIG_HOME="$TC/home/.config"
  export GEM_HOME="$TC/gems" GEM_PATH="$TC/gems" GEM_SPEC_CACHE="$TC/cache/gem-specs"
  export CP_HOME_DIR="$TC/cache/cocoapods" CP_CACHE_DIR="$TC/cache/cocoapods-downloads"
  export COCOAPODS_DISABLE_STATS=1 LANG=en_US.UTF-8
  # No telemetry, no Expo account, no upload to a crash-report account.
  export EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 DO_NOT_TRACK=1 CI=1 SENTRY_DISABLE_AUTO_UPLOAD=true
  unset EXPO_TOKEN EAS_BUILD_PROFILE SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT SENTRY_URL \
    GOOGLE_SERVICES_JSON RAKAZO_PASSKEY_DEVELOPER_MODE
  export EXPO_PUBLIC_API_URL="$API_URL"
}

toolchain() {
  local arch sum tar
  if [ "$("$TC/node/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
    case "$(uname -m)" in
      arm64) arch=arm64; sum=$NODE_SHA256_arm64 ;;
      x86_64) arch=x64; sum=$NODE_SHA256_x64 ;;
      *) die "no Node build for $(uname -m)" ;;
    esac
    say "installing Node $NODE_VERSION into .toolchain"
    tar="$TC/cache/node.tar.xz"
    curl --proto '=https' --tlsv1.2 -fsSL -o "$tar" \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.xz"
    echo "$sum  $tar" | shasum -a 256 -c - >/dev/null || die "the Node download does not match its checksum"
    rm -rf "$TC/node"; mkdir -p "$TC/node"
    tar -xJf "$tar" -C "$TC/node" --strip-components 1
    rm -f "$tar"
  fi
  if [ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ]; then
    say "installing pnpm $PNPM_VERSION into .toolchain"
    npm install --global --prefix "$TC/pnpm" --no-fund --no-audit "pnpm@$PNPM_VERSION" >/dev/null
  fi
}

# CocoaPods is only needed for a build. Its gems need Ruby 3.3 or newer and macOS ships 2.6, so a
# Ruby already on the host is used, read-only: DOZO_MOBILE_RUBY, the one on PATH, or the one
# Homebrew carries for itself. The gems go into the toolchain; no Ruby is installed.
find_ruby() {
  local r
  for r in "${DOZO_MOBILE_RUBY:-}" "$HOST_RUBY" /opt/homebrew/Library/Homebrew/vendor/portable-ruby/current/bin/ruby \
    /usr/local/Homebrew/Library/Homebrew/vendor/portable-ruby/current/bin/ruby; do
    [ -x "$r" ] && "$r" -e 'exit(RUBY_VERSION.split(".").map(&:to_i).first(2).<=>([3, 3]) >= 0 ? 0 : 1)' 2>/dev/null \
      && { echo "$r"; return 0; }
  done
  return 1
}

cocoapods() {
  local ruby
  ruby=$(find_ruby) || die "CocoaPods needs Ruby 3.3 or newer and none was found: set DOZO_MOBILE_RUBY to one"
  # Only ruby and gem are linked in: the directory they come from (a Homebrew bin, say) may hold a
  # host node or pod, and it never joins PATH.
  mkdir -p "$TC/ruby/bin"
  ln -sf "$ruby" "$TC/ruby/bin/ruby"; ln -sf "$(dirname "$ruby")/gem" "$TC/ruby/bin/gem"
  [ "$(command -v pod || true)" != "" ] && [ "$(command -v pod)" != "$GEM_HOME/bin/pod" ] && die "a pod outside the toolchain is on PATH"
  [ "$(pod --version 2>/dev/null)" = "$COCOAPODS_VERSION" ] && return 0
  say "installing CocoaPods $COCOAPODS_VERSION into .toolchain ($("$ruby" --version | cut -d' ' -f1,2), a few minutes, once)"
  rm -rf "$GEM_HOME"
  gem install cocoapods --version "$COCOAPODS_VERSION" --no-document --install-dir "$GEM_HOME" \
    --bindir "$GEM_HOME/bin" >"$TC/cache/gem-install.log" 2>&1 \
    || die "gem install cocoapods failed ($TC/cache/gem-install.log)"
}

deps() {
  need_stage
  ( cd "$SRC" && pnpm install --frozen-lockfile --store-dir "$TC/cache/pnpm-store" --filter "@rakazo/mobile..." ) >"$OUT/pnpm-install.log" 2>&1 \
    || die "pnpm install failed ($OUT/pnpm-install.log)"
}

need_stage() { [ -f "$APP/app.json" ] || die "no staged tree at $SRC"; }

# The resolved Expo config is what the native project is generated from: it must carry the Dozo
# values and nothing that ties the build to upstream's accounts. The old name may remain only in
# the identifiers the brand overlay keeps on purpose (dozo/brand/README.md, "Identifiers").
check_config() {
  ( cd "$APP" && pnpm exec expo config --type public --json ) >"$OUT/expo-config.json" 2>"$OUT/expo-config.log" \
    || die "expo config failed ($OUT/expo-config.log)"
  node "$HERE/check-config.mjs" "$OUT/expo-config.json" "$API_URL"
}

# One simulator of this script's own, so nobody else's device is booted, changed or shut down.
device() {
  local udid
  udid=$(xcrun simctl list devices | sed -n "s/^ *$DEVICE_NAME (\([0-9A-F-]*\)).*/\1/p" | head -n 1)
  [ -n "$udid" ] || udid=$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE") \
    || die "cannot create a \"$DEVICE_TYPE\" simulator (xcrun simctl list devicetypes)"
  echo "$udid"
}

build() {
  local udid app id foreign
  xcrun --find xcodebuild >/dev/null 2>&1 || die "Xcode not found"
  cocoapods
  udid=$(device)
  # The generated project is throwaway: prebuild always starts from nothing.
  ( cd "$APP" && pnpm exec expo prebuild --platform ios --clean --no-install ) >"$OUT/prebuild.log" 2>&1 \
    || die "expo prebuild failed ($OUT/prebuild.log)"
  # Xcode's script phases find node here, not through a version manager in a shell profile.
  echo "export NODE_BINARY=\"$TC/node/bin/node\"" >"$APP/ios/.xcode.env.local"
  ( cd "$APP/ios" && pod install ) >"$OUT/pod-install.log" 2>&1 || die "pod install failed ($OUT/pod-install.log)"
  # The generated project (Info.plist, entitlements, Expo.plist, the Xcode project), not only the
  # config it came from: nothing of upstream's accounts, ids or domain may have reached it.
  foreign=$(grep -rIlE 'com\.rakazo|07f7eb04|u\.expo\.dev|inbox-?zero|rakazo\.(com|ai|app)' "$APP/ios" --exclude-dir=Pods || true)
  [ -z "$foreign" ] || die "the generated iOS project names upstream's account, ids or domain: $foreign"
  say "xcodebuild (Release, simulator): the log is $OUT/xcodebuild.log"
  xcodebuild -workspace "$APP/ios/Dozo.xcworkspace" -scheme Dozo -configuration Release \
    -sdk iphonesimulator -destination "id=$udid" -derivedDataPath "$OUT/derived" \
    -clonedSourcePackagesDirPath "$OUT/derived/SourcePackages" \
    CLANG_MODULE_CACHE_PATH="$OUT/derived/ModuleCache.noindex" COMPILER_INDEX_STORE_ENABLE=NO \
    build >"$OUT/xcodebuild.log" 2>&1 || die "xcodebuild failed ($OUT/xcodebuild.log)"
  app="$OUT/derived/Build/Products/Release-iphonesimulator/Dozo.app"
  [ -d "$app" ] || die "the build left no $app"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl install "$udid" "$app"
  xcrun simctl launch "$udid" "$id" >/dev/null
  say "app: $app ($(du -sh "$app" | cut -f1)), bundle id $id"
  say "simulator: $udid (screenshot: xcrun simctl io $udid screenshot shot.png)"
}

clean() {
  local udid
  udid=$(xcrun simctl list devices 2>/dev/null | sed -n "s/^ *$DEVICE_NAME (\([0-9A-F-]*\)).*/\1/p" | head -n 1)
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    xcrun simctl delete "$udid"
  fi
  rm -rf "$OUT"
  say "clean: build output and the \"$DEVICE_NAME\" simulator removed; .toolchain kept ($(du -sh "$TC" 2>/dev/null | cut -f1))"
}

case "${1:-}" in
  check) preflight; mkdir -p "$OUT"; timed stage; seal; toolchain; timed deps; check_config; say "check PASS" ;;
  sim) preflight; mkdir -p "$OUT"; timed stage; seal; toolchain; timed deps; check_config; timed build; say "sim PASS" ;;
  clean) clean ;;
  *) echo "usage: $0 check|sim|clean" >&2; exit 64 ;;
esac
