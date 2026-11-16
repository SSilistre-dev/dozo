# Dozo

Dozo is a hosted service of persistent AI bots, each with its own computer. This repository is its
open source code. It is an independent fork of [Rakazo](https://github.com/elie222/rakazo)
(Apache-2.0) and is not affiliated with or endorsed by the Rakazo project.

## Principle

The committed tree is upstream plus new files. We do not edit upstream files. The one exception is a
fork notice at the top of the root `README.md`, delimited by `dozo:fork-notice` comments.

Why: upstream lands about 2,500 commits a month and we merge it continuously. Every edited upstream
file is a permanent merge conflict. New files never conflict.

The rename from Rakazo to Dozo is not committed. A codemod is applied to a throwaway staged copy of the
source right before the Docker build, and a leak gate fails the build if upstream branding survives.
Branded output is never committed.

## Layout

| Path | What it is |
| --- | --- |
| `dozo/brand/` | The brand overlay: `brand.json` (rules, names, placeholders), `apply.mjs` (codemod), `check.mjs` (leak gate) |
| `dozo/docker/` | Staging and image build, the compose ports override, the gate. See `dozo/docker/README.md` |
| `dozo/theme/` | Theme tokens and assets for the Dozo look |
| `dozo/design/` | Design reference: the source of truth for how Dozo should look |
| `dozo/sync.sh`, `dozo/SYNC.md` | Merging upstream. See `dozo/SYNC.md` |
| `dozo/NOTICE` | Licence addendum and notice of changes |
| `dozo/AGENTS.md` | Rules for agents and contributors in this fork |
| `dozo/LAUNCH-CHECKLIST.md` | What the owner must decide or supply before going public |
| `packages/ui-web/src/dozo.css` | Dozo styles, an in-package new file |
| `packages/ui-web/src/dozo-avatar.tsx` | Dozo bot avatar component, an in-package new file |

These two UI files live in `packages/ui-web/src/` because they must resolve inside that package. They
are new files, so they do not conflict with upstream.

## Build and run

Nothing is installed on the host. Everything runs in Docker.

- Build and run the stack: see `dozo/docker/README.md`.
- `make olc`: fast check, under 30 seconds. Run after every change.
- `make qa`: full gate. Run before merging.
- The gates exit with code 2 on failure.

## Syncing with upstream

Run `dozo/sync.sh` and follow `dozo/SYNC.md`. Branch `upstream-main` is pristine upstream and `main` is
ours. Upstream's GitHub workflows are disabled in our repository; see `dozo/SYNC.md`.

## Deliberately not renamed

Technical identifiers keep their upstream names so that merges and tooling keep working: the
`@rakazo/*` packages, `RAKAZO_*` environment variables, database names, HTTP headers, storage keys,
cookie names and the `rakazo://` URL scheme. Only user-visible strings, links and assets change, and
only at build time.

## Licence and attribution

Apache License 2.0, see `LICENSE`. Upstream's `NOTICE` stays untouched; our addendum is
`dozo/NOTICE`. Dozo claims no right to the Rakazo name or marks, and does not reuse upstream's logo or
mascot. Dozo's name is not yet cleared as a trademark (see `dozo/LAUNCH-CHECKLIST.md`).
