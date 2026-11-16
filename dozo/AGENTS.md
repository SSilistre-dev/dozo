# AGENTS.md for the Dozo fork

Layered on top of the root `AGENTS.md`, which stays untouched and still governs code style, tests
and public-repo hygiene. Where the two differ on how to change files, this one wins.

## Invariants

- Never edit upstream files. The only upstream file the fork edits is the marked block at the top of
  the root `README.md`.
- Put work in `dozo/`, or in new `dozo-*` files inside upstream directories (see below).
- To change upstream behaviour or wording, add an anchored rule in `dozo/brand/brand.json`. It is
  applied to a staged copy at build time. Do not patch the source.
- Never rename technical identifiers: `@rakazo/*` packages, `RAKAZO_*` env vars, DB names, headers,
  storage keys, cookie names, the `rakazo://` scheme.
- Never hand-edit `messages.po` files.
- Never commit branded output or `dozo/.stage/`.
- Keep `NOTICE` and `LICENSE` untouched. Attribution additions go in `dozo/NOTICE`.
- Never claim endorsement by or affiliation with Rakazo. Never reuse upstream's logo or mascot.

## Fork features inside upstream directories

- Fork-only source files live inside upstream directories with a `dozo-` filename prefix, so
  upstream tooling (Vitest, Biome, tsc) covers them. `make qa` runs `dozo-*.test.ts(x)`.
- Reach an upstream file only through an anchored rule, preferably one import redirect to a
  `dozo-*` wrapper that re-exports the same name. List the wrapper in the rule's `requires`.
- Rules are idempotent (a re-run is a no-op) and fail loudly: exit 2, naming rule and file.
- Deviation: the local-model catalog (model names, runtime, hardware) lives in
  `apps/web/src/lib/dozo-local-model-catalog.ts`, not in `packages/core/src`. It has a single
  consumer and core placement would need an extra anchor. Move it to core when a second surface
  needs it.
- Deviation: the six Dozo avatar identity colours live in one typed constant in
  `packages/ui-web/src/dozo-avatar.tsx`, not in `@rakazo/ui-tokens`, because upstream's `botColors`
  has seven different hues and its `botEyeColor` is one dark ink where ours glow light.

## Commands

- `make olc`: run after every change. Must finish in under 30 seconds. A missing Node image is a
  failure, never a skip.
- `make qa`: run before merge. Per-step logs in `dozo/.stage/logs/`; per-file coverage of the fork's
  own `dozo-*` code and of `dozo/brand` must stay at 90% or more.
- `dozo/sync.sh`: merge upstream. Read `dozo/SYNC.md` first.
- Docker build and run: `dozo/docker/README.md`.

## Docker only

- Install nothing on the host. No host node or pnpm. No `pnpm install` on the host.
- Run tooling in Docker, for example `docker run --rm -v "$PWD":/repo -w /repo node:24-slim node ...`.
- Do not stop or remove containers, images or volumes you did not create.
- Never read or print `.env` files or secrets.

## Gates

- Every gate returns exit code 2 on failure. Do not weaken, skip or bypass a gate to get green.
- Fix the cause. If a gate is wrong, change the gate in `dozo/` and say so.

## Design

- The design reference lives in `dozo/design/`. Read it before any UI change.
- Style direction: dark, monochrome, minimal, lively bot characters. No dense or decorated UI.
- Theme tokens live in `dozo/theme/`.

## Recurring mistakes

(none yet)

Add entries as `date, mistake, correct way`. Keep at most 15. Delete an entry once a hook or test
enforces it.

## Foreign to this project

- Renaming packages, env vars, or other technical identifiers.
- Editing upstream CI workflows. Disable them as `dozo/SYNC.md` describes.
- Committing branded output or staged copies.
- Adding a dependency for what a few lines can do.
- Hand edits to generated files such as `messages.po`.
- Refactoring or reformatting upstream files "while there".
- Placeholders replaced with invented company names, domains or addresses.
