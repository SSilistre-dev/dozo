#!/usr/bin/env bash
# Sourced by gate.sh, metrics/token-kiyas.sh and desktop/tests/stack_e2e.sh: where the unit step's
# working copy of one staged tree lives inside the dozo-qa-deps volume. The pnpm store and corepack
# are shared by every checkout (the same volume, so node_modules hard-links into the store); the
# working copy is not: it is /cache/trees/<first 12 hex of sha256 of the tree's absolute path>, so
# two checkouts (or two trees given to DOZO_UNIT_SRC) never sync into, or test, each other's files.
# unit_tree_dir <absolute path of the staged tree> prints that directory as seen inside the volume.
unit_tree_dir() { printf '/cache/trees/%s\n' "$(printf %s "$1" | sha256sum | cut -c1-12)"; }
