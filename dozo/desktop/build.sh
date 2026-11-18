#!/usr/bin/env bash
# Builds the Dozo macOS app (Tauri 2, Rust). It runs on the host: Docker cannot build a macOS app.
# Usage: dozo/desktop/build.sh [check]
#   (no argument)  install the toolchain if it is missing, build a universal app (Apple silicon
#                  and Intel), write dist/Dozo.app and dist/Dozo.dmg and print their paths.
#                  With ~/.config/dozo/sign.conf (see sign.conf.example) both are signed with a
#                  Developer ID and notarized; without it the app is signed ad hoc.
#   check          cargo fmt --check, cargo clippy -D warnings, cargo test
# The Rust toolchain and the Tauri CLI go into dozo/desktop/.toolchain (git-ignored). Nothing is
# written to ~/.cargo, ~/.rustup, a shell profile or Homebrew. Needs the Xcode command line tools.
# Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
trap 'rc=$?; [ $rc -eq 0 ] || [ $rc -eq 64 ] || exit 2' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
export RUSTUP_HOME="$HERE/.toolchain/rustup" CARGO_HOME="$HERE/.toolchain/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
TAURI_CLI=2.12.5
SIGN_CONF="${DOZO_SIGN_CONF:-$HOME/.config/dozo/sign.conf}"

say() { echo "[desktop] $*"; }
die() { echo "[desktop] FAILED: $1" >&2; exit "${2:-2}"; }

toolchain() {
  [ "$(uname -s)" = Darwin ] || die "this builds a macOS app: run it on a Mac"
  xcrun --find clang >/dev/null 2>&1 || die "Xcode command line tools not found (xcode-select --install)"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    say "installing rustup into .toolchain"
    curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
  fi
  # The version and components in rust-toolchain.toml.
  rustc --version >/dev/null 2>&1 || rustup toolchain install
  if [ "$(cargo tauri --version 2>/dev/null)" != "tauri-cli $TAURI_CLI" ]; then
    say "building tauri-cli $TAURI_CLI (a few minutes, once)"
    cargo install tauri-cli --version "$TAURI_CLI" --locked
  fi
}

# The app icon and the logo on the local screens, from the approved brand files. Generated here,
# never committed or redrawn.
assets() {
  local src=../brand/assets/desktop/icon-macos.png set=icons/Dozo.iconset s
  cp ../brand/assets/logo-dark.svg ui/logo.svg
  [ ! icons/icon.icns -nt "$src" ] || return 0
  rm -rf "$set"; mkdir -p "$set"
  cp "$src" icons/icon.png   # what a debug build (check) shows in the Dock
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$src" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$src" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o icons/icon.icns
  rm -rf "$set"
}

check() {
  cargo fmt --check
  cargo clippy --all-targets --locked -- -D warnings
  cargo test --locked
  say "check PASS"
}

# Developer ID signature with the hardened runtime and a secure timestamp, and no entitlements
# (README, "Signing and distribution"). codesign waits forever when the keychain asks for approval
# on a locked screen, so it gets two minutes. Its output can name the identity: it goes to a file.
sign() {
  perl -e 'alarm 120; exec @ARGV' codesign --force --options runtime --timestamp \
    --sign "$DOZO_SIGN_IDENTITY" "$1" >target/sign.log 2>&1 \
    || die "codesign failed or waited for a keychain approval: $HERE/target/sign.log"
}

# Apple's notary service, then the ticket stapled on, so the first open works offline too.
notarize() {
  say "notarizing $(basename "$1") (a few minutes)"
  xcrun notarytool submit "${2:-$1}" --keychain-profile "$DOZO_NOTARY_PROFILE" --wait \
    --timeout 30m >target/notary.log 2>&1 || true
  grep -q 'status: Accepted' target/notary.log \
    || die "the notary service did not accept $(basename "$1"): $HERE/target/notary.log"
  xcrun stapler staple -q "$1" && xcrun stapler validate -q "$1" || die "stapling $1 failed"
}

# What Gatekeeper answers for a downloaded copy. Only the verdict is printed, not the signer.
gatekeeper() {
  local file=$1 out; shift
  out=$(spctl -a -vv "$@" "$file" 2>&1) || true
  case "$out" in
    *"source=Notarized Developer ID"*) say "Gatekeeper: accepted, Notarized Developer ID ($file)" ;;
    *) die "Gatekeeper does not accept $file" ;;
  esac
}

build() {
  local out=target/universal-apple-darwin/release/bundle/macos/Dozo.app app=dist/Dozo.app
  local dmg=dist/Dozo.dmg stage=target/dmg
  DOZO_SIGN_IDENTITY="" DOZO_NOTARY_PROFILE=""
  # shellcheck source=/dev/null
  [ ! -r "$SIGN_CONF" ] || . "$SIGN_CONF"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  # Ad-hoc signed by the bundler (tauri.conf.json: signingIdentity "-"); signed again below.
  cargo tauri build --target universal-apple-darwin --bundles app -- --locked
  rm -rf dist; mkdir -p dist
  ditto "$out" "$app"
  [ "$(lipo -archs "$app"/Contents/MacOS/* | xargs -n1 | sort | xargs)" = "arm64 x86_64" ] \
    || die "the app is not universal (arm64 and x86_64)"
  if [ -n "$DOZO_SIGN_IDENTITY" ]; then
    sign "$app"
  else
    say "no identity in $SIGN_CONF: signed ad hoc, opens only on this Mac"
  fi
  codesign --verify --deep --strict "$app" || die "the app's signature does not verify"
  if [ -n "$DOZO_SIGN_IDENTITY" ] && [ -n "$DOZO_NOTARY_PROFILE" ]; then
    # The service takes an archive, the ticket goes on the app itself.
    ditto -c -k --keepParent "$app" target/Dozo.zip
    notarize "$app" target/Dozo.zip
    gatekeeper "$app" -t exec
  fi
  # A plain disk image: the app and a link to /Applications. No Finder scripting.
  rm -rf "$stage"; mkdir -p "$stage"
  ditto "$app" "$stage/Dozo.app"; ln -s /Applications "$stage/Applications"
  hdiutil create -quiet -volname Dozo -srcfolder "$stage" -ov -format UDZO "$dmg"
  if [ -n "$DOZO_SIGN_IDENTITY" ]; then
    sign "$dmg"
    if [ -n "$DOZO_NOTARY_PROFILE" ]; then
      notarize "$dmg"
      gatekeeper "$dmg" -t open --context context:primary-signature
    else
      say "no notary profile in $SIGN_CONF: signed, not notarized, Gatekeeper still blocks it"
    fi
  fi
  say "app: $HERE/$app ($(du -sh "$app" | cut -f1))"
  say "dmg: $HERE/$dmg ($(du -sh "$dmg" | cut -f1))"
  say "open it: open \"$HERE/$app\""
}

case "${1:-build}" in
  build) toolchain; assets; build ;;
  check) toolchain; assets; check ;;
  *) echo "usage: $0 [check]" >&2; exit 64 ;;
esac
