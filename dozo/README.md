# Dozo

Dozo runs persistent AI bots, each with its own computer. Run it on your own server for free, or use
the hosted version (a free plan and paid plans). This repository is its
source code: source available, with Dozo's own files under the Elastic License 2.0 and the code it
builds on under Apache-2.0. Dozo is an independent fork of
[Rakazo](https://github.com/elie222/rakazo) and is not affiliated with or endorsed by the
Rakazo project.

## Principle

The committed tree is upstream plus new files. We do not edit upstream files. The two exceptions are a
fork notice at the top of the root `README.md`, delimited by `dozo:fork-notice` comments, and three
issue forms under `.github/ISSUE_TEMPLATE/` (`dozo/AGENTS.md`, Invariants).

The repository page on GitHub shows `.github/README.md`, a new file, in place of the root `README.md`,
which stays upstream's below the notice.

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
| `dozo/deploy/` | Running the server side on one host behind a Dokploy panel: deploy and roll back, the production compose layer, firewall rules for bot computers, backups and a health check. See `dozo/deploy/README.md` |
| `dozo/desktop/` | The macOS app: a Rust (Tauri 2) window around the web app, built on the host. See `dozo/desktop/README.md` |
| `dozo/mobile/` | The iOS app: upstream's Expo app built as Dozo from the staged tree, simulator only so far. See `dozo/mobile/README.md` |
| `dozo/sync.sh`, `dozo/SYNC.md` | Merging upstream. See `dozo/SYNC.md` |
| `dozo/LICENSE`, `dozo/NOTICE` | The licence of the fork's own files, which files those are, and the notice of changes |
| `dozo/AGENTS.md` | Rules for agents and contributors in this fork |
| `dozo/LAUNCH-CHECKLIST.md` | What the owner must decide or supply before going public |
| `dozo-*` files in `apps/` and `packages/` | Fork-only source (local models, the bot avatars, the shell stylesheet). They sit inside upstream packages so they resolve there; they are new files, so they do not conflict with upstream |

## Build and run

Nothing is installed on the host (the exceptions: `dozo/AGENTS.md`). Node tooling runs in Docker.

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

## Hosted plans

Billing is off unless the server has the payment secrets (`docs/self-host-billing.md`), and a
server that does not bill behaves as upstream's does. A server that bills offers three plans, laid
over upstream's own-model tiers by `packages/contracts/src/dozo-plans.ts`:

- **Free** (tier `standard`): permanent, no card, no trial. Bots run on the member's own model
  connection. No hosted computer: the server refuses to start one, and a computer on the member's
  own machine still works. A bot still answers; a run that reaches for the computer fails and
  offers the paid plans. A new organization starts here, and one whose subscription ends returns
  here.
- **Premium** (tier `pro`) and **Premium Plus** (tier `max`): upstream's Pro and Max terms, a
  monthly computer allowance and a computer size. They start without a trial.

Upstream counts computer hours only on a metered cloud provider. Here every computer the server
hosts counts, the shipped Docker provider included, so the allowance holds on our own host.

Each plan has a shared space: the bytes of files an organization may keep across its Spaces, 500 MB
on Free, 2 GB on Premium and 5 GB on Premium Plus (`sharedSpaceBytes` in
`packages/contracts/src/dozo-plans.ts`). Files are what `artifacts` rows record: uploads, files
bots attach or generate, inbound attachments, kept screenshots and imported files, every version
counted. `packages/db/src/dozo-shared-space.ts` refuses the write that takes the organization over
(`shared_space_full`), inside the transaction that records the file and behind a lock per
organization, so writes running together cannot pass the limit between them. Nothing is deleted
and everything stays readable when a plan ends with more than Free allows; only new files are
refused until enough is deleted. Only a live Premium or Premium Plus subscription raises the limit;
every other organization, one that only buys credits included, has Free's. The billing status
carries the plan's name and the bytes in use (`sharedSpace`, read with the same count), which
Billing shows on web and mobile; a server that does not bill sends none. The test beside that
file lists upstream's writers of file rows and fails when a sync brings one it does not know. The
lock, the count across Spaces and row security are tested in `dozo-shared-space.postgres.test.ts`,
which needs a migrated database (`VERIFY_DATABASE=1` and `DATABASE_URL` of the runtime login); the
unit gate has none and skips it, so run it by hand after changing the check.

An organization on Free spends nothing of the operator's. The operator's own model already needs
credits (upstream's guard, on every model call a run or a background job makes). On top of that,
`packages/adapters/src/dozo-plans.ts` withholds media generation and the operator's external
reviewer from a run unless the organization pays (a live subscription or a credit balance); with
no reviewer the run asks the person before a consequential action, as upstream does for any
reviewer it cannot reach.

Tier ids and price lookup keys are upstream's and never change. Prices change in that one file;
until the owner sets them it carries none and the paid plans keep upstream's amounts. Known limits:

- A paid plan is bought on the web, in Settings > Billing. The mobile app shows the plan and
  changes between paid plans, but upstream's mobile plan choice has no tiers, so it cannot start
  one.
- While a server has a free plan, a computer's saved home is never deleted for an ended plan
  (upstream deletes it only when the organization can no longer run bots).
- The shared space counts files only. A computer's saved home (no size is recorded; upstream caps
  one at 5 GiB), pages, memory and messages (database text) are not counted.
- An import that does not fit is refused whole, after its files were written and removed again.
- An image or video is not generated when the shared space has no room at all: the bot is told
  why and nothing is spent. One that starts with room left and still does not fit is reported as a
  failed generation, without the reason, and its cost is not returned.
- A mail's attachment that does not fit is left out; the mail itself arrives.
- Nobody may hold a paid subscription to tier `standard`: it would pay and get no computer. No
  such subscription exists, since the server has never billed, and Free cannot be checked out: a
  checkout that names no paid plan is refused as `plan_not_offered`.
- The shared space in use shows in Billing only, read when the screen opens. The files screen
  does not show it: it would need a second read of the billing status.
- Upstream's own billing tests (`*.test.ts` without the `dozo-` prefix) assert upstream's plans;
  they run on the pristine tree only.
- Three optional operator services have no plan check and stay off on a server with a free plan
  unless that cost is accepted: a keyed web search provider (`WEB_PROVIDER=keenable` with
  `KEENABLE_API_KEY`), the operator's managed app connectors (`COMPOSIO_API_KEY`,
  `PIPEDREAM_*`) and bot mail (`BOT_EMAIL_SMTP_URL`, limited per person per day). The default web
  search needs no key.
- Upstream's marketing pricing page (`apps/www`) is not built or branded and still describes
  upstream's plans.

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
- The local model panel ships with an empty catalog (`LOCAL_MODELS` in
  `apps/web/src/lib/dozo-local-model-catalog.ts`) until tool calling has been tried against a real
  runtime; no model is downloaded or tested before then.
- Known upstream defect, not caused by the rename: the first boot of a new team's computer can answer
  500 "computer home is not usable by uid 1000" on macOS Docker Desktop or Colima bind mounts. Retry
  succeeds. It is upstream's ownership check. The e2e suite marks it as expected and fails the day it
  stops happening. On the Linux host of `dozo/deploy/`, where the home is a named volume, the first
  boot succeeded.

## Licence and attribution

The fork's own files are under the Elastic License 2.0 (`dozo/LICENSE`); upstream's files stay under
the Apache License 2.0 (`LICENSE`). `dozo/NOTICE` says which file is which and from which commit.
Dozo is source available, not open source: do not describe it as open source. Upstream's `NOTICE`
stays untouched; our addendum is `dozo/NOTICE`. Dozo claims no right to the Rakazo name or marks, and does not reuse upstream's logo or
mascot. Dozo's name is not yet cleared as a trademark (see `dozo/LAUNCH-CHECKLIST.md`).
