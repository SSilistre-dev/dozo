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
| `dozo-*` files in `apps/`, `packages/` and `infra/` | Fork-only source (local models, the bot avatars, the shell stylesheet). They sit inside upstream packages so they resolve there; they are new files, so they do not conflict with upstream |

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
  own machine still works. A bot still answers. A run is not offered the tools that need the
  hosted computer and is told it has none, so it works with web lookups and connected apps and,
  when a task truly needs a computer, says the member can connect their own from the desktop app or
  upgrade (`packages/adapters/src/dozo-no-computer.ts`). The same holds for a paid plan whose hours
  for the period are spent. It is decided once at the start of the run, with the check that refuses
  the computer's start; a paused turn resumes with the tools it had, and a server that does not
  bill never withholds the computer. A new organization starts here, and one whose subscription
  ends returns here.
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
refused until enough is deleted. Only Premium or Premium Plus in force raises the limit: a live
subscription to it, or a plan an admin granted that has not ended (the higher of the two counts);
every other organization, one that only buys credits included, has Free's. The billing status
carries the plan's name and the bytes in use (`sharedSpace`, read with the same count), which
Billing shows on web and mobile; a server that does not bill sends none. The test beside that
file lists upstream's writers of file rows and fails when a sync brings one it does not know. The
lock, the count across Spaces and row security are tested in `dozo-shared-space.postgres.test.ts`,
which needs a migrated database (`VERIFY_DATABASE=1` and `DATABASE_URL` of the runtime login); the
unit gate has none and skips it, so run it by hand after changing the check.

An admin can change two numbers per plan without a deploy, on the admin page's Plans section: its
shared space and, on Premium and Premium Plus, its monthly computer hours (at least one; Free never
gets hours). Prices stay in code: a new price is a new price at the payment provider. The values
live in `dozo_plan_quotas` (`packages/db/src/dozo-plan-quotas.ts`); an empty one follows the
terms in `dozo-plans.ts`. Every limit reads them from the database on each request, so a change
holds on every instance at once: the shared space, the computer allowance, the hours Billing shows
and the check that a move to a smaller plan fits this month's use. Each change is a
`deployment.settings.changed` security event. Lowering a quota deletes nothing, as above. The
landing page still shows the terms in code, so the admin page says in one line what it states
when a value differs.

An organization on Free spends nothing of the operator's. The operator's own model already needs
credits (upstream's guard, on every model call a run or a background job makes). On top of that,
`packages/adapters/src/dozo-plans.ts` withholds media generation and the operator's external
reviewer from a run unless the organization pays (a live subscription or a credit balance); with
no reviewer the run asks the person before a consequential action, as upstream does for any
reviewer it cannot reach.

An admin can give a member's own organization Premium or Premium Plus for a while, from the admin
page (Set plan), without a subscription. The grant is a row in `dozo_plan_grants` (tier, end date,
who gave it, an optional note) that the subscription sync never writes, so a webhook cannot
overwrite it. `tierInForce` in `packages/db/src/dozo-plan-grant.ts` is the one place that compares
the end date and takes the higher of the paid tier and an unexpired grant's; the computer allowance
and size, the shared space, the operator's paid services and the billing status all read the plan
through it. A grant ends by that comparison alone: nothing runs when it ends, and the organization
is back on what it pays for, Free when nothing. A granted plan has no price and no billing row, so
the billing page shows no price for it. Billing (web and mobile) shows when the plan in force
renews or ends, a grant's end included, and the days left (`planEnd` in the status, picked in
`apps/api/src/dozo-plan-end.ts`); a plan that ends within seven days shows in the warning colour.
A grant above a subscription shows its end and the plan that follows, without the warning, and
the subscription keeps its own renewal line. An end already past is not sent.
Every change is an audit event in the organization's own audit log, as the operator: the event
names the admin only by id, never by email, and not the internal note (which stays on the grant
row). The event is the lasting record of who gave or ended
a plan, since a new grant overwrites the row's giver and ending one deletes the row; it is written
just after the change, as the audit primitive takes no transaction. Ending a plan that was not
there changes and records nothing. A grant ends at the end of a UTC day, and the page offers
tomorrow as the first. A grant only raises the computer allowance: it is at least the granted
tier's, whatever a trial or a monthly credit plan gives, and an organization with only a grant has
the monthly reset date. The table has no row security, as `billing_accounts` has none: the plan is
read inside a member's own requests and uploads.

Billing mails an organization's owners, the members who manage billing, in English or Turkish
(`packages/auth/src/dozo-billing-email.tsx`; no unsubscribe link, as they are not marketing): once
when a payment fails (again only after it was paid up in between), once when a subscription is set
to cancel (the day the plan lasts until), and three days before the plan in force ends without
renewing, a canceled subscription's or a granted plan's (the plan that follows). Only owners who
were owners when it happened, active and with a verified address of their own, are mailed.
The mails are never part of what they are about: `apps/api/src/dozo-billing-lifecycle.ts` runs
after every step of a sync and after an admin's plan change, reports its own failures, and is made
up for by the next sync, the backup jobs and an hourly sweep. It decides in one transaction that
locks the organization's row in `dozo_billing_notices` (what was already told) and reads the
subscription as stored then; an occasion counts as told only once a mail was recorded for an
owner, and the migration counted whatever was overdue or canceled at the time as told, so nothing
earlier is mailed. Each mail is a row in `dozo_billing_mails` with a backup job, sent after commit
without the caller waiting. A send claims its row and has a minute: sent, refused for good (never
tried again), or given back for the backup job; a claim left behind is taken over after five
minutes, so a mail the provider accepted just before a crash, a timeout or a failed mark can rarely
go twice. The reminder is one Graphile job per organization: it mails only if that is still the
end, then queues itself for the next one. The hourly sweep (a Graphile cron, once across all API
processes) queues a reminder that is missing, gives up on mails whose backup job ran out of tries,
and deletes settled mails after 90 days. The API runs these jobs
(`packages/adapters/src/dozo-job-queue.ts`) on a pool of two connections of its own; Graphile
checks once a minute for jobs that have come due, the one timed check besides the sweep. Without
account email nothing is sent. Receipts are the payment provider's own mails, turned on in its
settings, so none is written here. While a subscription is past due, web and mobile show the owner
one line with Manage billing.

A plan picked on the landing page follows the visitor to checkout. Its sign-up links carry
`?plan=premium|premium_plus&period=month|year`; the web sign-up page keeps a valid pick in session
storage for the tab and drops both parameters from the address (anything else, Free included, is
ignored). When the app opens after setup, `apps/web/src/pages/dozo-shell.tsx` opens Billing with that
plan and period selected, once: closing Billing forgets the pick and the account stays on Free. The
server still prices the tier and period itself, so a link cannot open a price that is not offered.
A plan checkout left unpaid returns to `/app?billing=canceled`, which reopens Billing quietly.

Tier ids and price lookup keys are upstream's and never change. Prices change in that one file;
until the owner sets them it carries none and the paid plans keep upstream's amounts. Known limits:

- A paid plan is bought on the web, in Settings > Billing. The mobile app shows the plan and
  changes between paid plans, but upstream's mobile plan choice has no tiers, so it cannot start
  one: an Upgrade from Free on mobile opens the web app's Billing in the system browser. Store
  rules on buying a digital subscription outside the app have not been checked.
- What a refused limit says and offers (Free's missing computer, spent hours, a full shared space,
  busy computers, the computer and Space counts, a checkout of Free) is one table,
  `packages/contracts/src/dozo-plan-limits.ts`, in English and Turkish only (the fork's sentences
  have no catalog). Every failure shown through `errorText` gets its sentence; the upgrade action
  is wired in the composer, the computer screen and mobile's failed-send alert. Only a member who
  manages billing is offered it. The run error's Details, shown to admins only on the web, give a
  limit's code (`computer_not_in_plan`, ...) instead of the server's English sentence.
- When a subscription and a higher grant coexist, the billing status reports the granted tier, so
  the plan picker marks that tier as current while the subscription bills the lower one.
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
- The cache share on Settings > Usage (`apps/web/src/components/dozo-cache-savings.tsx`) is
  translated to Turkish only, by fixed ids merged into the catalog there, since the fork never edits
  `messages.po`; other languages show the English. The mobile app does not show it: it has no usage
  screen to put it beside.
- Sites with cookies (the key button in a bot computer's header, `apps/api/src/dozo-site-sessions.ts`):
  sessions stay in the bot's browser profile on its computer; only site names, times and storage
  keys reach the server. A site is listed only when one of its pages was opened at the top level,
  so trackers and CDNs that only loaded inside other pages are left out. It is the cookies in this
  bot's browser, whoever opened the site: sites the bot browsed on its own are listed too. "Sign
  out of all" ends every site with cookies, unlisted ones included. The list needs a running
  computer, and only Docker computers declare it. The mobile app has no such view yet.
- Signing out and signing in hold the bot's execution lease so the script never runs a browser
  beside the bot's; a bot waiting for someone on its screen is not held up. An Own computer has
  no such lease (upstream's lease covers Team computers only), so there a sign-out the bot races
  can still meet its browser starting.
- What it makes visible: every member of the Space sees, for every bot there, which sites its
  browser holds cookies for and when each was last used, without who opened them (the audit log
  has that). Before, this was only on the screen of whoever looked at the browser.
- Each bot has its own browser profile, but on a Team Computer every bot runs as the same user in
  the same home, so any bot there (through its shell) can read another bot's profile, cookies
  included: a site one person signs in to through one bot is usable by every bot on that computer
  and by everyone who can direct them. Upstream's `docs/computer.md` says sign-ins are "carried
  over"; that is wrong about the mechanism and right about the reach. Use an Own computer for a
  sign-in that must not be shared.
- Own computer is the one name for a bot's computer of its own (`computerMode` `dedicated`): the
  bot settings switch, the Team / Own computer picker (agent import, mobile computer screen) and
  the shell tool's description say it. Upstream's `docs/computer.md` calls it "Private"; Dozo
  ships no docs site, so that page is not changed. A Team Computer bot is told in its instructions
  that the other bots there share its files and sign-ins, and to suggest Own computer when
  something must stay private. Under the switch, while it is off: on Free, that the plan has no
  computer (the switch is disabled, with Upgrade for a member who manages billing); otherwise that
  the Team Computer is shared with the Space's other bots. A switch the server refuses (computer
  limit, a running bot, a computer someone holds) says why beside it on web; mobile keeps its
  screen's error line. A full host memory budget never refuses the switch, only a later start
  ("All computers are busy").
- How many Own computers: `SANDBOX_MAX_COMPUTERS_PER_USER` (default 2, or the admin's value)
  counts computer rows that back a live bot, per person across their Spaces: each Space's Team
  Computer once (kept for the Space's owner), each Own computer once. With the default, a person
  with bots on their Team Computer can give one bot an Own computer; with every bot switched off
  the Team Computer, two. Premium's computer is 2 GB (`large=2:2`), so a 4 GB host budget runs
  two at once for the whole host, whoever owns them: a third start waits for one to sleep
  (`SANDBOX_IDLE_MS`).
- `browser_act`, `computer_act` and `shell` never ask for approval (`packages/core/src/action-approval.ts`),
  and outside-content gating applies only to webhook runs: on a signed-in site, a page that tricks
  the bot can make it post, delete or change settings unasked. Only payment presses and saved
  login or card fills ask. The sign-in dialog says so in one line on every computer ("The bot can
  act as you on these sites, and a page it reads can steer it."); the approval rules are unchanged.
- Known upstream defect, not caused by the rename: the first boot of a new team's computer can answer
  500 "computer home is not usable by uid 1000" on macOS Docker Desktop or Colima bind mounts. Retry
  succeeds. It is upstream's ownership check. The e2e suite allows it on that first start (and
  does not require it). On the Linux host of `dozo/deploy/`, where the home is a named volume, the first
  boot succeeded.

## Licence and attribution

The fork's own files are under the Elastic License 2.0 (`dozo/LICENSE`); upstream's files stay under
the Apache License 2.0 (`LICENSE`). `dozo/NOTICE` says which file is which and from which commit.
Dozo is source available, not open source: do not describe it as open source. Upstream's `NOTICE`
stays untouched; our addendum is `dozo/NOTICE`. Dozo claims no right to the Rakazo name or marks, and does not reuse upstream's logo or
mascot. Dozo's name is not yet cleared as a trademark (see `dozo/LAUNCH-CHECKLIST.md`).
