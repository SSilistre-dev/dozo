# AGENTS.md for the Dozo fork

Layered on top of the root `AGENTS.md`, which stays untouched and still governs code style, tests
and public-repo hygiene. Where the two differ on how to change files, this one wins.

## Invariants

- Never edit upstream files. Two exceptions, both held by `make olc` as exact file names:
  - the marked block at the top of the root `README.md`;
  - the issue forms `.github/ISSUE_TEMPLATE/config.yml`, `bug.yml` and `self-host.yml`, which the
    fork replaces whole. GitHub reads them from that path only, so a new file cannot override them,
    and upstream's sent reports to upstream. They must not name upstream and must not be deleted.
- Other community files are new files: `.github/README.md`, `.github/SECURITY.md` and
  `.github/CONTRIBUTING.md` (GitHub shows them before the root ones, which stay upstream's),
  `.github/PULL_REQUEST_TEMPLATE.md` and `.github/ISSUE_TEMPLATE/dozo-*.yml`.
- Put work in `dozo/`, or in new `dozo-*` files inside upstream directories (see below).
- To change upstream behaviour or wording, add an anchored rule in `dozo/brand/brand.json`. It is
  applied to a staged copy at build time. Do not patch the source.
- Never rename technical identifiers by hand. Which ones the overlay keeps (`@rakazo/*`, `RAKAZO_*`,
  DB names, headers, storage keys, cookies, `rakazo://`) and the few persisted ones it renames on
  purpose: `dozo/brand/README.md`, "Identifiers".
- Never hand-edit `messages.po` files.
- Never commit branded output or `dozo/.stage/`. The screenshots in `dozo/brand/assets/readme/` are
  not build output: they are the pictures `.github/README.md` shows, taken from a local stack with
  placeholder data.
- Keep `NOTICE` and `LICENSE` untouched. Attribution additions go in `dozo/NOTICE`.
- The fork's own files are under the Elastic License 2.0 (`dozo/LICENSE`, never reworded); upstream's
  stay Apache-2.0. `dozo/NOTICE` holds the one list of which file is which: a new kind of fork file
  goes there. Dozo is "source available", never "open source" (`make olc` holds the landing page and
  `.github/README.md` to it).
- `LICENSE-DOZO` is a new root file without the `dozo-` prefix: GitHub lists a second licence only
  from a root file named `LICENSE*`. If upstream ever adds that name, the sync conflicts: keep ours.
- Never claim endorsement by or affiliation with Rakazo. Never reuse upstream's logo or mascot.

## Fork features inside upstream directories

- Fork-only source files live inside upstream directories with a `dozo-` filename prefix, so
  upstream tooling (Vitest, Biome, tsc) covers them. `make qa` runs `dozo-*.test.ts(x)`.
- Reach an upstream file only through an anchored rule, preferably one import redirect to a
  `dozo-*` wrapper that re-exports the same name. List the wrapper in the rule's `requires`.
- Rules fail loudly: exit 2, naming rule and file. `--strict` semantics: `dozo/brand/README.md`.
- Deviation: the local-model catalog (model names, runtime, hardware) lives in
  `apps/web/src/lib/dozo-local-model-catalog.ts`, not in `packages/core/src`. It has a single
  consumer and core placement would need an extra anchor. Move it to core when a second surface
  needs it.
- Deviation: the six Dozo avatar identity colours live in one typed constant, `DOZO_BOT_PALETTE` in
  `packages/core/src/dozo-avatar-art.ts` (next to the art, shared by the web component and the
  server-side notification portrait), not in `@rakazo/ui-tokens`, because upstream's `botColors`
  has seven different hues. `packages/ui-web/src/dozo-shell.css` writes two colours no token
  carries: the seal dot's red, and the logo band's red for `packages/ui-web/src/dozo-logo.tsx`, as
  the brand file `dozo/brand/assets/logo-dark.svg` has it (a test holds drawing and file equal).
- Closed registration: `SIGNUPS_ENABLED=false` reaches the client as `signupsOpen` in the public
  auth capabilities (anchored rules in `packages/contracts/src/auth.ts` and `apps/api/src/app.ts`).
  `apps/web/src/pages/dozo-auth.tsx` then shows sign-in at the sign-up address and
  `dozo-shell.css` hides the link to sign-up. The field exists only in the staged tree.

## Commands

- `make olc`: run after every change. Must finish in under 30 seconds. A missing Node image or a
  missing `upstream-main` ref is a failure, never a skip (the ref: `dozo/SYNC.md`, Prerequisites).
- `make qa`: run before merge. Per-step logs in `dozo/.stage/logs/`.
- What each gate runs, the coverage floors, variables and exit codes, and the local-versus-CI stage
  difference: `dozo/docker/README.md`. Do not lower a floor to get green.
- `dozo/sync.sh`: merge upstream. Read `dozo/SYNC.md` first.
- Project status and known limits: `dozo/README.md`.

## Docker only

- Install nothing on the host. No host node or pnpm. No `pnpm install` on the host. The one
  owner-accepted exception is `dozo/brand/assets/build.sh`, which renders the logo files with host
  node, python3 and Brave; run it only when the logo masters change.
- The macOS app (`dozo/desktop/`) is the second exception: Docker cannot build one. Build it only
  with `dozo/desktop/build.sh`, which keeps Rust and the Tauri CLI in `dozo/desktop/.toolchain/`
  and writes nothing to `~/.cargo`, `~/.rustup`, a shell profile or Homebrew.
- The iOS app (`dozo/mobile/`) is the third exception: Docker cannot build one. Build it only with
  `dozo/mobile/build.sh`, from the branded staged tree, never in `apps/mobile`. It keeps Node, pnpm,
  CocoaPods and every cache in `dozo/mobile/.toolchain/` and the build in `dozo/mobile/.build/`, and
  writes nothing to `~/.npm`, `~/.cache`, `~/.cocoapods`, Xcode's DerivedData, a shell profile or
  Homebrew. No Apple account, signing, device or cloud build: `dozo/mobile/README.md`.
- Run tooling in Docker, for example `docker run --rm -v "$PWD":/repo -w /repo node:24.22-slim node ...`.
- Do not stop or remove containers, images or volumes you did not create.
- Never read or print `.env` files or secrets.

## Gates

- Every gate returns exit code 2 on failure (usage errors 64; other codes: `dozo/docker/README.md`).
  Do not weaken, skip or bypass a gate to get green.
- Fix the cause. If a gate is wrong, change the gate in `dozo/` and say so.

## Design

- The design reference lives in `dozo/design/`. Read it before any UI change.
- Style direction: dark, monochrome, minimal, lively bot characters. No dense or decorated UI.
- Theme tokens live in `dozo/theme/`.

## Recurring mistakes

- 2026-11-17, a leak-gate row with a free part (a directory, a variable, a host) swallowed the old
  name inside it and passed a path that carried the name twice. Correct way: a new or widened row
  gets a `no` sample with the name in every free part before it is trusted.
- 2026-11-17, a fix was reported closed while an older definition of the same function, left later
  in the script, still ran. Correct way: after editing a shell function, count its definitions
  (`grep -c '^name()'`) and prove the fix with a case the old code fails.

Add entries as `date, mistake, correct way`. Keep at most 15. Delete an entry once a hook or test
enforces it.

## Foreign to this project

- Renaming packages, env vars, or other technical identifiers outside a reviewed rule.
- Editing upstream CI workflows. Disable them as `dozo/SYNC.md` describes.
- Committing branded output or staged copies.
- Adding a dependency for what a few lines can do.
- Hand edits to generated files such as `messages.po`.
- Refactoring or reformatting upstream files "while there".
- Placeholders replaced with invented company names, domains or addresses.
