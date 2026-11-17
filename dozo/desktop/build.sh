#!/usr/bin/env bash
# Builds the Dozo macOS app (Tauri 2, Rust). It runs on the host: Docker cannot build a macOS app.
# Usage: dozo/desktop/build.sh [check]
#   (no argument)  install the toolchain if it is missing, build, write dist/Dozo.app and
#                  dist/Dozo.dmg and print their paths
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

build() {
  local app=target/release/bundle/macos/Dozo.app dmg
  # Ad-hoc signed by the bundler (tauri.conf.json: signingIdentity "-").
  cargo tauri build --bundles app -- --locked
  codesign --verify --deep --strict "$app" || die "the app's signature does not verify"
  rm -rf dist; mkdir -p dist
  ditto "$app" dist/Dozo.app
  # A plain disk image: the app and a link to /Applications. No Finder scripting.
  dmg=target/dmg
  rm -rf "$dmg"; mkdir -p "$dmg"
  ditto "$app" "$dmg/Dozo.app"; ln -s /Applications "$dmg/Applications"
  hdiutil create -quiet -volname Dozo -srcfolder "$dmg" -ov -format UDZO dist/Dozo.dmg
  say "app: $HERE/dist/Dozo.app ($(du -sh dist/Dozo.app | cut -f1))"
  say "dmg: $HERE/dist/Dozo.dmg ($(du -sh dist/Dozo.dmg | cut -f1))"
  say "open it: open \"$HERE/dist/Dozo.app\""
}

case "${1:-build}" in
  build) toolchain; assets; build ;;
  check) toolchain; assets; check ;;
  *) echo "usage: $0 [check]" >&2; exit 64 ;;
esac
