#!/usr/bin/env bash
# Builds the Dozo Linux app (Tauri 2, Rust) inside Docker: nothing is installed on the host.
# Usage: dozo/desktop/build-linux.sh [check]
#   (no argument)  build the AppImage and the .deb (x86_64) into dist/ and print their paths
#   check          cargo fmt --check, cargo clippy -D warnings, cargo test
# The image is Ubuntu 22.04, so the AppImage runs on that release's glibc and newer. Rust and the
# Tauri CLI go into .toolchain/linux (git-ignored), the build into target/ (git-ignored). The
# versions are the ones build.sh and the workflow use: rust-toolchain.toml, TAURI_CLI in
# build.sh, Cargo.lock. The workflow (dozo-desktop-linux) installs LINUX_PACKAGES itself.
# Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
trap 'rc=$?; [ $rc -eq 0 ] || [ $rc -eq 64 ] || exit 2' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
IMAGE=dozo-desktop-linux:22.04
LINUX_PACKAGES="build-essential curl file pkg-config libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf"

die() { echo "[desktop] FAILED: $1" >&2; exit "${2:-2}"; }

case "${1:-build}" in
  build | check) ;;
  *) echo "usage: $0 [check]" >&2; exit 64 ;;
esac
command -v docker >/dev/null || die "docker not found"

docker build -q -t "$IMAGE" - >/dev/null <<EOF || die "building the image failed"
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates $LINUX_PACKAGES && rm -rf /var/lib/apt/lists/*
EOF

mkdir -p .toolchain/linux
# Runs as the calling user, so the files it writes in this directory stay theirs.
# Capped so a build leaves room for the rest of a shared machine.
docker run --rm -i --cpus 3 --memory 6g -e CARGO_BUILD_JOBS=3 -u "$(id -u):$(id -g)" \
  -v "$HERE/..:/dozo" -w /dozo/desktop -e HOME=/tmp \
  -e RUSTUP_HOME=/dozo/desktop/.toolchain/linux/rustup \
  -e CARGO_HOME=/dozo/desktop/.toolchain/linux/cargo \
  -e TAURI_CLI="$(sed -n 's/^TAURI_CLI=//p' build.sh)" \
  -e APPIMAGE_EXTRACT_AND_RUN=1 -e MODE="${1:-build}" "$IMAGE" bash -s <<'EOF'
set -euo pipefail
export PATH="$CARGO_HOME/bin:$PATH"
say() { echo "[desktop] $*"; }
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  say "installing rustup into .toolchain/linux"
  curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
fi
rustc --version >/dev/null 2>&1 || rustup toolchain install
if [ "$(cargo tauri --version 2>/dev/null)" != "tauri-cli $TAURI_CLI" ]; then
  say "building tauri-cli $TAURI_CLI (a few minutes, once)"
  cargo install tauri-cli --version "$TAURI_CLI" --locked
fi
# The icons and the logo, from the approved brand files (never committed here).
cargo tauri icon ../brand/assets/desktop/icon.png --output icons --png 32,128,256,512 >/dev/null 2>&1
cp ../brand/assets/logo-dark.svg ui/logo.svg
if [ "$MODE" = check ]; then
  cargo fmt --check
  cargo clippy --all-targets --locked -- -D warnings
  cargo test --locked
  say "check PASS"
  exit 0
fi
cargo tauri build -- --locked
rm -rf dist; mkdir -p dist
cp target/release/bundle/appimage/*.AppImage target/release/bundle/deb/*.deb dist/
EOF
[ "${1:-build}" = check ] || for f in dist/*; do echo "[desktop] $HERE/$f ($(du -h "$f" | cut -f1))"; done
