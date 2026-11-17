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
| `dozo/brand/` | The brand overlay: `brand.json` (rules, names, placeholders), `apply.mjs` (codemod), `check.mjs` (leak gate). See `dozo/brand/README.md` |
| `dozo/docker/` | Staging and image build, the compose ports override, the gates. See `dozo/docker/README.md` |
| `dozo/e2e/` | Browser suite against the running stack. See `dozo/e2e/README.md` |
| `dozo/theme/` | Theme tokens for the Dozo look and the compose override that loads them. See `dozo/theme/README.md` |
| `dozo/design/` | Design reference: the source of truth for how Dozo should look |
| `dozo/sync.sh`, `dozo/SYNC.md` | Merging upstream. See `dozo/SYNC.md` |
| `dozo/NOTICE` | Licence addendum and notice of changes |
| `dozo/AGENTS.md` | Rules for agents and contributors in this fork |
| `dozo/LAUNCH-CHECKLIST.md` | What the owner must decide or supply before going public |
| `dozo-*` files in `apps/` and `packages/` | Fork-only source (local models, the bot avatars, the shell stylesheet). They sit inside upstream packages so they resolve there; they are new files, so they do not conflict with upstream |

## Build and run

Nothing is installed on the host (one exception: `dozo/AGENTS.md`). Node tooling runs in Docker.

- `make up` builds and starts the stack; `make olc` is the fast check (run after every change);
  `make qa` is the full gate (run before merging). Commands, variables, exit codes:
  `dozo/docker/README.md`.
- Gates exit with code 2 on failure.
- `make olc` needs a local `upstream-main` branch; the first-time commands are in `dozo/SYNC.md`.

## Syncing with upstream

Run `dozo/sync.sh` and follow `dozo/SYNC.md`. Branch `upstream-main` is pristine upstream and `main` is
ours.

## Identifiers

Technical identifiers keep their upstream names so that merges and tooling keep working; a few
persisted ones are renamed on purpose. The list of both is in `dozo/brand/README.md` (Identifiers).

## Status and known limits

Accepted by the owner for now, stated here once:

- Nothing is pushed to GitHub yet and upstream's workflows are not disabled (`dozo/SYNC.md`). Neither
  `dozo-gate.yml` nor `dozo-sync.yml` has ever run on GitHub Actions.
- `dozo-gate` runs only `make olc`, `stage`, `brand` and `unit`, never `build`, `up`, `smoke` or the
  e2e suite. Its required status check is named after its job, `olc, brand leak gate and fork unit
  tests` (it was `olc and brand leak gate`): branch protection must name the new one.
- Interrupt handling (SIGINT, SIGTERM and cleanup in the scripts) is implemented but not rehearsed
  against a real long run.
- A local `make qa` stages uncommitted files while CI stages HEAD only (`dozo/docker/README.md`).
- Known upstream defect, not caused by the rename: the first boot of a new team's computer can answer
  500 "computer home is not usable by uid 1000" on macOS Docker Desktop or Colima bind mounts. Retry
  succeeds. It is upstream's ownership check. The e2e suite marks it as expected and fails the day it
  stops happening.

## Licence and attribution

Apache License 2.0, see `LICENSE`. Upstream's `NOTICE` stays untouched; our addendum is
`dozo/NOTICE`. Dozo claims no right to the Rakazo name or marks, and does not reuse upstream's logo or
mascot. Dozo's name is not yet cleared as a trademark (see `dozo/LAUNCH-CHECKLIST.md`).
