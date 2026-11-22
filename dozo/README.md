# Dozo

Dozo runs persistent AI bots, each with its own computer. Run it on your own server for free, use
the hosted version at [app.dozo.bot](https://app.dozo.bot) (a free plan and paid plans; sign-up is
open), or install the desktop app for macOS, Windows or Linux and keep the server and your chats
and files on your own computer (what is sent to a model goes to the provider you chose). This repository is its
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
| `dozo/desktop/` | The desktop app for macOS, Windows and Linux: a Rust (Tauri 2) window around the web app, built on the host. See `dozo/desktop/README.md` |
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
  for the period are spent, and for an overdue payment, where the bot names the payment instead.
  It is decided once at the start of the run, with the allowance the computer's start checks, read
  alongside the run's other setup; if that read fails the run keeps its computer. A turn paused in
  computer mode, for a takeover or after using the computer keeps it; a message with files from a
  run without it is refused plainly. A server that does not bill never withholds the computer. A
  new organization starts here, and one whose subscription ends returns here.
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
reviewer it cannot reach. A monthly credit plan's computer share counts only while its
subscription is live: its amount stays on the billing account after cancellation, and with Free's
model access an ended plan would otherwise keep getting computer hours (`packages/db/src/sandbox-allowance.ts`).

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
- While a server has a free plan, a computer's saved home is never deleted: neither 30 days after
  a paid plan ends nor after 90 days unused (upstream deletes it only when the organization can no
  longer run bots, and on Free every organization can).
- The referral program is off: its reward is a month of the cheapest plan, which is Free, so
  `apps/api/src/referrals.ts` turns itself off and no reward is offered or paid.
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

## Model pool

A person's own connections to the same provider can stand in for each other. When the one a run is
on runs out of quota or credit, or its key is refused, before anything is shown, the call moves to
the next open connection of the pool, and the one that ran out rests until the provider's reset
(else an hour, at most a week). The next runs skip it until then and go back to it after. It is a
handover, not a way around rate limits: a short rate limit, an overload or an empty reply retries
as before and never moves to another connection of the pool, and a run stays on one connection.

- The rule is `packages/core/src/dozo-model-pool.ts`; the runtime side and the anchored rules it
  needs are in `packages/adapters/src/dozo-model-pool.ts`; which kinds of connection may join is
  `dozo-model-pool-capabilities.ts` (keys, own endpoints and subscription sign-ins).
- Subscription sign-ins: a pool of them is the person's own accounts, used under each provider's
  terms, which are theirs to keep. One that ran out rests for its account (a digest of the account
  id the provider gives), so a token refresh or signing in again with the same account keeps the
  rest and another account ends it; a provider that gives no account id rests the sign-in instead,
  like a key. Two connections signed in to the same account are one member. A sign-in that must be
  made again leaves the pool until it is, and a run whose chosen connection is one starts on the
  next. A usage window's reset is read from the provider's headers or its "try again in" words,
  else the default rest. No quota endpoint is called.
- The pool lives in two fork tables with no model in `schema.prisma` (`dozo_model_pool_members`,
  `dozo_model_connection_cooldowns`, `packages/db/src/dozo-model-pool-store.ts`). A connection
  without a row runs exactly as upstream's does. The store's SQL and row security are tested in
  `dozo-model-pool-store.postgres.test.ts`, which needs a migrated database (see Hosted plans).
- When every connection rests, the run tries the one that opens first and fails with the
  provider's own message. A pinned run keeps the connection it asked for. Moving to another
  connection mid-run rebuilds the provider's prompt cache, so that call costs more.
- Settings: where two or more of one provider's connections may join (the first five added), each
  of their pages in Models has one switch that pools all of them or none
  (`apps/web/src/pages/model-settings/dozo-model-pool.tsx`, procedures `dozoModelPool.get` and
  `dozoModelPool.set` in `apps/api/src/dozo-model-pool.ts`, the offer in
  `packages/adapters/src/dozo-model-pool-settings.ts`). The server refuses any other connection,
  records each change in the activity log (`model.pool.changed`) and sends the person's roster
  signal. A resting connection's row shows when it opens; a rest that starts while Models is open
  shows when it is opened again or the window gets focus. A connection added later joins when the
  switch is turned on again. Mobile has the same switch and time on a connection's page
  (`apps/mobile/components/dozo-model-pool-switch.tsx`), read again on each roster signal.

## Editing and regenerating

In a person's own chat with a bot, the More menu offers Edit on their last message and Regenerate
on the bot's last reply (`apps/api/src/dozo-message-revision.ts`). The server names the one message
each applies to; the menu reads that while it is open. Only the newest turn can change, and only when
going back undoes nothing outside the chat:

- the message is the caller's own, sent from the app: not from a chat app (that app already holds
  the reply and cannot unsend it), not a spoken call, not a group;
- the runs it started have ended (earlier ones are those an edit or regenerate replaced; the newest
  wrote the reply), and none called a tool or recorded an external effect (the same test upstream
  uses before retrying a routine run). A bot that searched, wrote memory, sent mail or used its
  computer gets neither option, since those cannot be taken back;
- nothing else was said after the reply, and no run in the chat is working or waiting.

The old reply is deleted with its events, so its words stay nowhere in the chat or in what the
model reads next; the next reply takes its seq, so the history keeps no gap. An edit replaces the
message's text. The old run row stays for usage. A server-side memory provider that already learned
the finished turn keeps it: providers forget per chat, not per turn, so only clearing the chat
removes it. Old clients drop the removed reply on their next read instead of at once.

Mobile offers the same two in a message's long-press menu (`apps/mobile/lib/dozo-message-actions.ts`);
Edit opens its own screen. The iOS menu is built before it opens, so the open chat reads what may
change again whenever its newest message or a run changes (`apps/mobile/lib/dozo-thread-menus.ts`).

## Pinned messages

Any message in a bot's or a group's chat can be pinned from its More menu
(`apps/api/src/dozo-message-pins.ts`, table `dozo_message_pins`). A pin belongs to the person who
made it, like their read state: other members of the Space who share the chat never see it, since
a pin marks what one person wants to find again, not a decision for everyone. Leaving the Space
drops that person's pins there. While a chat has pins, a pin in its header lists them, newest first,
and opens the chat at the one chosen. A chat keeps the 50 newest pins.

A deleted message takes its pins with it: a regenerated reply, a cleared chat. An edited message
keeps its pin with the new text. A pin change sends the person's own roster signal; the web app
reads the open chat's pins again on every roster signal, so a pin made on another device and a
message deleted elsewhere both show within the roster's signal spacing (10 seconds). Chat export
leaves pins out.

Mobile pins from the same long-press menu, and lists a chat's pins from the bot profile's menu or
group settings, only while there are some; choosing one opens the chat at it. The app reads a
chat's pins again on every roster signal.

## A bot's extra chats

A bot can hold extra chats beside its main one (`apps/api/src/dozo-bot-chats.ts`, table
`dozo_bot_chats`; web, desktop and mobile). They are the Space's, like the bot's main chat:
every member who can open the bot sees and uses them. A bot holds at most 20 open extra chats and
100 in all; an archived one is read only (nothing new is sent to it) and leaves search, as an
archived bot does. The bot's memory and computer are one across its chats. Chat apps use the main
chat only. The phone's badge and the inbox rows count main chats only, as web's Dock badge and bot
rows do; an extra chat has its own unread dot.

On the phone a bot's extra chats are on its profile (reached from the chat's title), under Chats,
only when it has some: a tap opens one on its own route, a long press opens its sheet (rename, mark
as read or unread, snooze, pinned, export, archive). New chat is in the profile's "..." menu, and
names the chat by when it began, as on web. A chat route holds one chat (`DozoChatScope`, from its
`chatId`, or from the `threadId` of a notification: the main chat opens at once, with no request,
when that is the bot's main thread as the inbox or the saved copy knows it; any other thread waits
for the bot's chat list, and one it cannot place (an unreadable list, or an archived chat while the
main thread is known) shows the bot's profile, never the main chat); its main chat and an extra chat of the same bot can be stacked and share nothing: draft,
unsent sends, read visit, saved copy, pages, live stream and notifications are each the chat's own,
and every request about the chat on screen is built by `dozoChatTarget` in
`apps/mobile/lib/dozo-chat-target.ts`. In an extra chat there are no calls, no attachments and no
waiting line (the contract names a bot or a group only); `dozo-chat-callsites.test.ts` counts every
place the app asks about a chat.

The bot API, CLI and MCP reach an open extra chat by its id (`?chat=`, `--chat`, `chat_id`), through
one rule in `apps/api/src/dozo-api-chats.ts`; without one, every call is the main chat as before. A
chat the token cannot reach (another bot's or Space's, archived, missing, the main chat's own id) is
one 404, never the main chat. A token cannot make, rename or archive chats: its scope is "talk to
my bots", which says nothing about changing them. A chat app's conversation lands in the bot's main
chat (`dozo-bot-api-chats.postgres.test.ts` pins it); mapping a conversation to an extra chat is a
product decision not made yet.

A routine or one-time wait posts in the chat it was made in, or the one picked in its editor (web,
shown only once the bot has an extra chat): upstream's `routines.threadId`, read by
`packages/adapters/src/dozo-routine-chat.ts` for schedules, waits, change triggers, retries and Run
now, so quiet hours, the 12-hour catch-up, the daily send limit and queued ticks meet the same chat.
No chat (every routine made in the app before) is the main chat. While its chat is archived a
routine (the daily digest too) runs in the main chat and says so there once per archiving, in its
owner's language; brought back, it posts there again. A routine named in a message runs in the chat
the message was written in, and keeps its own chat.
Webhook, GitHub, email and chat-app triggers still deliver in the main chat, as upstream delivers
them, and the phone's editor neither shows nor changes the chat (an edit there keeps it).

Requests name an extra chat as `chatBotId` with `chatId`, never as `botId`. Deploy the API before
(or with) the web app: an API from before extra chats answers such a request with 400 (its own
"one of botId or groupId" check) and the app shows that error, instead of dropping `chatId` and
writing to the main chat. Clearing works in the main chat only; it clears the helper threads the
main chat started, not those of an extra chat.

## Organization logo

An organization's owner uploads its logo under Settings, Organization
(`apps/api/src/dozo-organization-logo.ts`, the auth library's own `organization.logo` column, so no
migration). The role is checked on the server before the picture is decoded. The bytes must be the
PNG, JPEG, WebP or GIF the upload names; an SVG is never taken, since it can carry a script. What is
stored is a 128 px square WebP the server drew itself: cropped to the middle, the first frame of a
GIF, transparency laid on white so dark ink shows in the dark theme. Only such a value is ever
handed to an app.

The logo shows in one place: the start of the sidebar header (web and desktop), and the home header
on mobile, for the organization the open Space belongs to. A guest of a shared Space sees the host's
logo there and their own in their own Spaces; someone who leaves the Space stops getting it at once.
A change sends the roster signal of every Space of the organization. No colour is taken from the
logo: the app stays monochrome. Mobile shows the logo only; it is uploaded on the web or desktop app.

## Organization skill library

An organization's owner puts a skill they wrote in its library with the Organization switch in the
skill's editor (web and desktop; shown once the organization has someone to share with). Every
member of the organization's Spaces then finds it in their skills, marked Organization and read
only, and their bots use it: the catalog, `/` and `skill_read` reach it
(`packages/db/src/dozo-organization-skills.ts`, tables `dozo_organization_skills` and
`dozo_organization_skill_hides`, `apps/api/src/dozo-organization-library.ts`). It is the one
skill system widened: the skill stays its owner's `agent_skills` row, only the owner changes or
deletes it, and writes keep the owner-only lookup.

One read decides what a member gets, on every read and in a row-level policy, never by clean-up:
they are a member of the open Space; the person who shared the skill still owns the organization
(`dozo_is_owner_role`, the SQL twin of `isOwnerRole`, tested against it) and still owns the skill.
A sharer demoted, removed or deleted takes the skill out of every member's reach at once. A member's
own skill and a built-in skill of the same name win over a library skill; a skill named like a
built-in cannot be shared. Names compare by `skillNameKey` (`packages/core/src/dozo-skill-name.ts`),
the key the resolver `findSkillByName` uses too, so padding a name gets around neither. The account
import keeps names as given (upstream's behaviour), which is why that matters. A member turns a library skill off for their own bots with the same
switch (listed under their skills while off, to turn back on). A change to the library, or the
owner changing or deleting a skill in it, signals every Space of the organization.

Trust: a library skill is the owner's text inside a member's bot, which runs with the member's
own secrets, connections, memory and approval rules; the owner can change the text later. Only the
text and its files are shared; nothing is written to or run on a computer by sharing. A run started
from a chat app by someone who is not the bot's owner gets built-in skills only, as before. Mobile
marks library skills in the list and opens them read only; turning one off is on the web or desktop.

## Feedback

The account menu's Send feedback opens a short note with an optional Include diagnostics switch
(`apps/api/src/dozo-feedback.ts`, `apps/web/src/components/dozo-feedback*.tsx`). It goes to the
address in `DOZO_FEEDBACK_EMAIL`; without one the item is not shown. With an email provider the
server mails it there, as plain text with the sender's own address to reply to. Without one the
dialog saves the report as a text file and shows the address to send it to.

Diagnostics are the surface (web or desktop), the browser's user agent, language and time zone,
the server's revision, and the ids and times of the sender's own failed runs in the last 7 days
(never their error text). The dialog shows the exact lines added under the note before anything is
sent, and the server sends only the runs it showed. Nothing is sent without the person pressing
Send. Limits: 5 reports per person and 60 in all per hour, per API instance.

Not yet: the mobile app has no entry, and the local server shows none until the desktop app passes
it an address. There is no anonymous path to the hosted service from a local server.

## Bot API

Scripts talk to a member's own bots under `/api/v1/dozo` (`apps/api/src/dozo-bot-api*.ts`,
OpenAPI in `dozo/api/openapi.yaml`): list bots, send a message and follow the reply as
server-sent events, read the chat, export it. Each call carries a personal access token made under
Settings > General > Security > Access tokens (`apps/web/src/components/dozo-access-tokens.tsx`).

A token belongs to one member in one Space and can be limited to one bot. Only its SHA-256 and last
four characters are stored (`dozo_access_tokens`); it is shown once. Making one asks the person to
confirm it is them (as revealing a secret does) and mails the account's address when a mail
provider is set. It lasts 90 days unless made to never expire, and every token stops when the
account's password changes or is reset, or its owner or an operator signs out everywhere. It goes with its bot and with the member's place in the
Space, and stops for a deactivated or banned account. Revoking ends open streams within 10 seconds;
runs already started go on. Making and revoking one is in the activity log; the list shows when
each was last used.

It is read from the `Authorization` header only, never a cookie or the address, so another site
cannot call the API with a signed-in browser. It reaches the app's own send, transcript and export
procedures as its member (`createRouterClient`), so access checks, approvals and model limits are
the app's. Settings, billing, members and tokens are out of its reach: the app's RPC never accepts a
token. A stop word is refused (in the app it stops every run in the chat): stop a run in the app.
A message sent with a token never answers or ends a question the bot is waiting on.

Reads are open: a run started with a token reads, without asking, whatever its bot can read
(chats, files, memory, mail, connected apps) and the reply can carry it back. A token limited to one
bot reaches everything that bot can read.

Token gate (`packages/adapters/src/dozo-token-run.ts`, `dozo-token-marks.ts`, shared with MCP). Text
sent with a token may come from another program or agent, so it is not the owner's word. It is saved
with an `api:` client nonce (`packages/core/src/dozo-token-source.ts`) and shows a small key above
it on web and mobile. A bot is marked while its chat holds such a message (clearing the chat ends
it), while a bot it was spawned from is marked, or while it holds a mark: one is written when text
from a marked bot's run is delivered to it (a message, a delegated run's automatic answer, a group
handoff) or a marked run wrote its instructions or a ticket it now owns, until its chat is cleared
after that. A bot a marked run spawned, and the bot of a routine a marked run made or changed, stay
marked until that bot or routine is deleted. Background helpers and routines of a marked bot are
its runs; conversation memory keeps no turn of a marked run, and a message sent with a token never
answers or ends a question the bot is waiting on.

In a run of a marked bot every call that is not a plain read asks the person, even in Never ask or
Auto review: sends, connector writes, the cloud computer, the browser, files, memory, settings,
routines, other bots and the user's own computer; in Never ask, a skill or routine write is refused
instead (After outside content). The gate only asks: marks are written where the
approved call delivers or changes something, so a call the person denies leaves none, and a call
naming another bot by anything but a string is refused. Its cards say why (and, for work that
outlives the run, that the mark does too) and have no Always allow; the run starts as having read
outside content, and a marked routine's words and the sites a token's message names are not
trusted. An approved call goes ahead once without asking again, also when replayed after a restart;
the API call does not wait: its stream ends with `waiting_input`. A background helper of a marked
bot cannot ask, so it refuses such calls.

The owner ends a mark from the bot's menu in the web app: Trust this bot again, after confirming it
is them (logged as an approval change; no token reaches it). Messages and marks from before then no
longer make the bot ask, though its history still counts as outside content. Not marked: a bot that
later reads a ticket a marked run commented on or that has no owner.

Limits: 60 requests and 10 messages a minute per token and 20 messages a minute per account,
counted in Postgres for every API instance (`dozo_api_minutes`); 120 requests a minute per address
(an IPv6 caller by its /64; a request whose address the server cannot tell is refused) before any
token is looked up and 3 open streams per token, per instance. A stream holds at most 1 MB for a
reader that stopped reading, then ends with `running`. A stream ends after 10 minutes with
`running`. Not yet: the mobile app has no token screen (a token is for a computer's scripts; make
one on web or desktop) and no Trust this bot again, the notice mail is in English, and there is no group chat or attachment
support.

## Agent mode (unverified)

On the local server only (the desktop app runs it and passes `HOST_USER_HOME` and `HOST_USER_PATH`),
a provider's own agent CLI can run a bot's whole turn as the person: Codex, through its own
app-server (`packages/adapters/src/cli-models/dozo-agent.ts` and `codex/dozo-codex-agent.ts`). It
was written against Codex 0.171's protocol schema and has not been run against a real, signed-in
Codex yet, so it is off until turned on by hand:

- **Turn it on:** put `codex-agent` on its own line in `dozo-agent-tools` in the server's data
  folder (the `data/` next to the server's other files), then restart the app. Remove the line, or
  the file, to turn it off. No settings screen shows or changes this.
- **Connecting:** Settings > Models then shows Codex, marked Agent. Connecting asks the person to
  agree to what agent mode means and checks, there and then, that Codex is 0.171.x, is signed in,
  and reaches Dozo's tools through the bridge; a failed check says why and saves nothing.
- **A turn:** one Codex process per run, in an empty folder of the bot's own under
  `data/agent-work/`, sandboxed to that folder, asking only the person (never Codex's own reviewer).
  Codex's requests to run a command, change files or get more access become an approval card with
  "Allow once" and "Decline"; Dozo never answers for the session. Dozo's own tools reach Codex
  through a stdio MCP bridge that runs them in the run's tool executor, so approvals, daily sends
  and the token gate apply; its socket and key last only as long as the run.
- **Interrupted, never re-run:** a run waiting for the person keeps its Codex process in the server
  process that started it, for 30 minutes at most. If another process (or the same one after a
  restart) picks the run up, it ends with "The agent was interrupted" instead of starting Codex
  again; a mark in `data/agent-runs/` holds this across processes.
- **ACP agents:** Antigravity (`antigravity-agent`, run as `agy acp`) and Grok (`grok-agent`, run
  as `grok agent stdio`) are driven over the Agent Client Protocol
  (`packages/adapters/src/cli-models/acp/`), turned on the same way, one id per line. Dozo offers
  them no file or terminal methods: they use their own tools and ask through ACP permission
  requests, answered only with the one-time allow or reject option (never an "always" one), and
  every waiting request is answered as cancelled when a turn stops. The connection check reads the
  agent's version from `initialize` (Antigravity 1.5.x; no Grok version has been checked yet, so
  Grok cannot be connected), its sign-in from `session/new`, and waits for it to list Dozo's tools.
  Antigravity also asks the person to accept, separately, that Google's terms count this use as a
  reason to close their account. ACP reports no usage limits: an agent's own error is shown as is.
- **Not in agent mode:** runs that text sent with an access token reached (until the bot is trusted
  again), and every run the person did not start with their own message in Dozo.
- **Not yet:** more accounts or the model pool for agents, mobile.

## Commands on your own computer

Upstream asks once per Space before a bot first runs a command on the member's own computer (the
desktop app's "Let bots use this computer"), and after "Allow in this space" runs every later
command there unasked. The fork keeps that first card and then reads each command
(`packages/adapters/src/dozo-user-computer-gate.ts`, `packages/core/src/dozo-shell-command.ts`):

- A command that only reads (`ls`, `cat`, `grep`, `find` without `-exec` or `-delete`, and a few
  more in `READ_ONLY_PROGRAMS`) goes ahead.
- Any other command asks with Allow once, Always allow this command and Deny. Always allow saves
  the exact words for that bot, in that folder, on that computer (table `dozo_command_policies`);
  Settings > Approvals lists them under Commands, where each can be changed or removed.
- Never ask keeps upstream's behaviour: the first card alone. Auto asks like Ask; no approval model
  reads commands yet. A block rule on the tool still refuses every command.

### Command rules

Each rule is the member's, for one bot (in a group chat, the rules of the member whose run it is).
A bot another bot starts or messages runs under its own rules, which start empty, so a block for
one bot does not hold for another. A rule does one of three things
(`packages/core/src/dozo-command-rule-match.ts`):

- **Allow**: exactly these words, in this folder. It needs the command to read as one literal
  program (above), so chaining, substitution, redirection, a variable before the program, `sudo`
  or `bash -c` never pass by a rule.
- **Allow with arguments**: these words followed by more plain words, offered only for plain
  readers whose arguments only name what to read or print (`PREFIX_PROGRAMS`: `basename`, `cat`,
  `cmp`, `df`, `diff`, `dirname`, `du`, `echo`, `file`, `grep`, `head`, `ls`, `pwd`, `readlink`,
  `realpath`, `stat`, `tail`, `tree`, `wc`, `which`), by their plain name, and never for a rule
  whose folder is a secret place (`.ssh`, `.aws`, Library, an absolute path outside the system
  folders). Every other command is allowed exactly or not at all, and the settings do not offer
  the choice: test runners (`pytest evil.py` picks the code that runs), git (a repository the bot
  can edit can make `git status` or `git diff` run a program through its configuration or hooks),
  any Windows program, and everything unknown. An added word may not be an option or a setting
  (nothing starting with `-`, no `=`), and must pass the read-only gate's check for secret places
  (`readableWord`: no absolute path outside the system folders, no `..`, no hidden or private
  location, no drive, no `/S`).
- An exact rule runs the same words every time, but not always the same code: `npm test`, `make`
  or `git status` run what the project's files say today, and the bot may have edited those files.
- **Block**: refuses any command containing these words on either computer, in any folder and in
  every mode, Never ask included, before an allow rule and before the Space's first card. From the
  program (by name: a path, case, `.exe`, an escape), the rule's other words follow in order within
  that command, with anything between, compared as paths (`./x/../build/` is `build`; only slashes
  mean the root `/`; `../build` stays another folder), and its short options appear in any order or form (`rm -rf` refuses `rm -fr`,
  `rm -r --force`; `git push -f` refuses `--force`, `--force-with-lease` and `+main`). A variable or
  substitution after the program in the same command can stand for the rest (`git $(echo push)`),
  and an unquoted glob for a word it matches (`git pu*h`). It reads through quotes, invisible marks,
  full-width letters, `sudo`, `env` and `bash -c '…'`, and checks a routine's command watch both
  when it is made and at every check. A best effort, not a security boundary: it errs toward
  refusing (`echo git push` is refused) and does not follow a program name built from variables
  (`X=r; Y=m; $X$Y`), `eval`, encoded text (`base64 -d | sh`), `python -c`, aliases or scripts the
  bot writes first, and it does not know PowerShell's own names and abbreviations (`Remove-Item -r
  -fo build` is not `rm -rf build`; block the PowerShell form as its own rule).
- A rule saved on the member's own computer allows on it; an exact one also allows on the bot's
  computer, which holds less of theirs. A rule saved on the bot's computer never allows on the
  member's own. A prefix rule stays on the computer it was saved on.
- Settings > Approvals > Commands (web and mobile) changes a rule between the three or removes it;
  a member sees and changes only their own rules in the current Space.
- The rules moved to `dozo_command_policies`. Until the deferred migration drops
  `dozo_command_rules`, removing a rule or making it anything but an exact allow also removes its
  copy there, so a previous release still running during a deploy, or rolled back to, never allows
  it. A rule saved during that window by the previous release is not carried over: it asks again.
- The card for a command on the bot's computer reads "Run on the bot's computer?" ("Botun
  bilgisayarında çalıştırılsın mı?"). Like every approval card title, the server writes it in
  English and no surface translates it yet.

### Commands on the bot's computer

Upstream never asks before a command on the bot's own computer: it is an isolated machine without
the member's files. The fork keeps that default (`packages/adapters/src/dozo-command-gate.ts`), so
no bot starts asking after this change. Block rules refuse there in every mode. In a run that
outside text started (a webhook), where upstream asks, an exact allow rule lets the command go
ahead as an always-allow rule for the tool would; a prefix rule does not, and a run a token's text
reached still asks. "Ask before commands on bot computers" (Settings > Approvals, shown once the
Space has such a computer) makes a command that does more than read ask, outside Never ask, with
the same card and Always allow; it is per account (table `dozo_command_settings`). It covers
`shell` only: typing into a terminal through screen control or writing a script with the file
tools is not read.
- Only the owner's own chats reach their computer, never routines, webhooks or chat apps, so no
  card waits on a run nobody watches.

How a command is read, and what that does not cover:

- The server does not know which shell runs it (the computer's login shell, or PowerShell on
  Windows), so it reads only what is plain in zsh, bash, fish and PowerShell: one program and its
  words, each bare or wholly quoted. Other shells (tcsh, nushell) were not considered. Two
  commands, pipes, redirections, variables, globs, `~`, braces, subshells, backslashes, an
  assignment before the program, `//` anywhere in a word (a Windows network share), curly quotes,
  control characters and invisible format marks make it unreadable. An unreadable command always
  asks, and offers no Always allow.
- The read-only list names what may pass, never what must ask, so a script, an interpreter or a
  copy of a program under another name asks. A program is matched by its bare name; a path asks.
- What a program does is not checked. An alias or function in the member's login profile can
  make `ls` do anything; a command allowed by a rule (`npm test`) runs whatever its files say
  today; a program put earlier on `PATH` by a command the member allowed runs under the name of a
  read-only one. Reading does not ask, including files that hold secrets. A Mac can
  reach the network through `/net/<host>` paths, which a read-only command may list.
- A rule is the member's for that bot on any of their own computers, not one device, and stays
  when a computer is removed and paired again (the Space's first card does not). It matches the
  exact words and the folder as the bot wrote it; `~/app` and the same folder by its full path
  are two rules. The card offers Always allow only when it shows the whole command
  (nothing hidden as a secret, nothing cut off).
- Deny on any command makes the rest of that reply refuse commands on the computer, as upstream
  does for a denied tool; the next message starts afresh.

The mobile app lists them too, from a Commands row beside approval Rules that shows only while
there is one (`apps/mobile/app/(settings)/dozo-commands.tsx`). Not done yet: screen control on
the member's computer keeps upstream's approval per app. The fork's
desktop app answers every screen request with "Screen control is not available on this computer"
(`dozo/desktop/src/device_run.rs`) and a bot's browser tools never run on the member's computer
(a computer on the user's machine is not graphical), so no browser or screen action reaches it
yet; only upstream's Electron app, which the fork does not ship, drives apps there. Asking per
action belongs with adding screen control to the fork's app. The server offers a connected computer
the screen tools only when it declares screen control on connecting
(`packages/adapters/src/dozo-device-capabilities.ts`; the desktop app declares commands only), tells the bot it can only run commands there, and answers a
refused screen request with that fact (`packages/adapters/src/dozo-device-screen.ts`).

## Your phone's calendar

A bot may read the calendar on the member's own phone (`phone_calendar_read`,
`packages/adapters/src/dozo-phone.ts`; the app's side is `apps/mobile/lib/dozo-phone-device.ts`).
The phone pairs as one of the member's devices and declares `calendar` only while Calendar is on in
its Phone settings and the system allows it. Phones are not computers: they never get commands,
screen or browser, stay out of Computers and its limit, and an account has one phone.

- Only the member who started the run reaches their own phone, from a chat no one else can read: not
  a group, a channel or a helper's thread, and only in a Space where they are the only member.
- Each bot's first read asks, Never ask included; turning Calendar off unpairs the phone, so every
  bot asks again. Once outside content entered the run every read asks, and the phone's own answer
  counts as outside content, so a second read in a run asks too (a range over 31 days takes two
  approvals, by choice).
- At most 31 days and 50 events, with title, times, location and calendar name. Links are removed
  from those texts on the phone and again on the server by one shared rule; the rest of the text
  goes to the bot's model as written.
- The approval record keeps a count, not the events, and a turn that read the phone is not learned
  into memory. What the bot replied stays in the chat like any message: export and backups carry
  it, and a member added to the Space later can read it with the rest of its history.
- Known limits: only while the app is open in front (a phone that does not answer fails after 20
  seconds); not over the relay (a phone paired to a computer by code), which carries no device
  connection; a store build without the native module hides the setting.

## Daily sends

Each bot may make a number of sends a day for a member without asking them
(`packages/adapters/src/dozo-send-limit.ts`, `packages/db/src/dozo-send-limit.ts`); past it, each
send asks with a card that says why and offers Allow once and Deny only. Settings > Approvals sets
the number for the account (50 until changed, 1 to 1000), under the mode.

- A send is `send_email`, `message_agent`, or an app action upstream's gate counts as changing
  something (declared not read-only, or named like a change, the same test that makes it ask in
  Ask mode). A batch counts each such action, plus one for an entry that names none; a call whose
  sends do not fit in what is left asks, and none of them is counted. Page browser presses,
  including form submits, are not counted yet: telling a submit from another click needs a new
  probe in the computer's page browser. Paid service calls (`service_call`, `paid_request`) and
  the member's own cloud coding agents are not sends here.
- Counted when the gate would let it go without a person: allowed by Never ask or an Always allow
  rule, or left to the approval model. A send a person approves on its card is not counted. One
  the approval model then asks about, or that fails, still counts, so the number errs towards
  asking sooner. A run resumed after a crash may count a call twice for the same reason.
- Per member, per bot, per day of the member's timezone (UTC until one is set), so each new bot
  has its own number. One conditional upsert per call (table `dozo_daily_sends`), so concurrent
  sends on any number of instances never count past the number. Rows older than yesterday go when that bot next sends. A bot that
  changes the member's timezone (`update_preferences`, offered in the member's own chats only)
  can move to a date that has not started elsewhere: the timezones in use span at most three
  dates at once, so that is at most three days' sends in one real day.
- It asks in every mode, Never ask included; a block rule still refuses. Where a card cannot wait,
  upstream's rules hold: a background helper refuses instead. Webhook and routine runs post the
  card as they do for any other gated action.
- The card's reason is English, like every card detail the server writes. Mode's description
  for Never ask ("Asks only before purchases and the first use of your computer") does not mention
  it. The mobile app has no setting for the number; it shows the card.
- `send_email` keeps upstream's own account-wide cap of recipients a day (`botEmailDailyLimit`,
  set by the operator), which refuses rather than asks.

## MCP endpoint

Outside MCP clients (code editors, other agents) reach a person's own bots over Streamable HTTP at
`/api/v1/dozo/mcp`, with one of the Bot API's personal access tokens in an
`Authorization: Bearer` header (`apps/api/src/dozo-mcp.ts`, `packages/adapters/src/dozo-mcp*.ts`).
Tools: `list_bots` and `send_message`, which waits up to 45 seconds for the reply and returns at
once when the bot asks a question or needs an approval (that is answered in the app); each bot's
chat is the resource `dozo-chat://<bot id>`, the newest 64,000 characters of the chat export. A
token reaches only the bots its owner made in its Space, or its one bot. The server keeps no
session (each request is authenticated on its own) and answers protocol versions up to 2025-11-25;
a newer client falls back to those. A token's requests and an account's messages count against the
Bot API's budgets (a token's share and the account's total of messages), shared by every instance; an address that presents 20 refused tokens in a minute
waits a minute (per instance); bodies up to 64 KiB. A bare stop word is refused: stop a run in the app.

A message sent over MCP carries the token mark, so the Bot API's token gate holds its run: it asks
in the app before any outside effect, whatever the approval mode, and nothing it names is taken as
the owner's own word.

On the server on your own computer, point a local client at
`http://127.0.0.1:<web port>/api/v1/dozo/mcp` with the same header; the web port is the address
the app window opens.

## After outside content

A run that read outside content, or that someone else started, is held to a few lasting limits
(`packages/core/src/dozo-lasting-write-approval.ts`, `packages/adapters/src/dozo-lasting-write-card.ts`):

- Creating, changing or deleting a skill, and creating or changing a routine, needs a person in
  every mode, over any Always allow rule; Never ask refuses it. The card shows the whole text that
  will be saved (a skill change as a diff of the current skill); a text too long to show whole is
  refused instead of asked. In the owner's own clean run nothing changes.
- Its turn is not saved to a connected memory service. Turns saved before this change may come from
  such runs. Recalled memory still reaches the model as data, not instructions, and does not by
  itself make a run count as having read outside content.

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
- Code mails (sign-in code, account deletion) carry the Dozo footer's Privacy, Terms and contact
  links like every account mail, so "a code mail has no link" no longer tells a real mail from a
  fake one.
- A Dozo avatar drawn at 120 px is over a push's 1050-byte image budget, so pushes carry only the
  96 px one.
- Kubernetes, Incus and local-VM computers need an image built from this tree
  (`KUBERNETES_SANDBOX_COMPUTER_IMAGE`, `INCUS_SANDBOX_COMPUTER_IMAGE`, `LOCAL_VM_COMPUTER_IMAGE`):
  upstream's published image, their default, keeps its home at `/home/rakazo`. Without one their
  computers stay unavailable, naming the setting.
- The local model panel ("Run on this computer", web and desktop) lists the model servers running
  on the server's own computer at their default addresses (`DOZO_LOCAL_MODEL_SERVERS` in
  `packages/core/src/dozo-model-providers.ts`) and the models each one's `/v1/models` lists; a
  model connects in one click as an OpenAI-compatible connection without a key. It shows only where
  `MCP_ALLOW_PRIVATE_ENDPOINT=true` (the desktop app and the server bundle); a hosted server answers
  that nothing is available without sending a request. A server on another port or machine is
  connected by address under OpenAI-compatible, also on mobile. Whether a model calls tools is not
  read from the server: images and thinking stay the connection's own switches. Its hardware
  estimator still has an empty catalog (`LOCAL_MODELS` in
  `apps/web/src/lib/dozo-local-model-catalog.ts`) until tool calling has been tried against a real
  runtime.
- The cache share on Settings > Usage (`apps/web/src/components/dozo-cache-savings.tsx`) is
  translated to Turkish only, by fixed ids merged into the catalog there, since the fork never edits
  `messages.po`; other languages show the English. The mobile app does not show it: its Usage
  screen (`apps/mobile/app/(settings)/dozo-usage.tsx`) has the grouped spend and the CSV only.
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
- Switching moves the bot's files and browser sign-ins (`packages/adapters/src/dozo-computer-move.ts`,
  after one confirmation line on web and mobile). Only the bot's creator or the Space owner may
  switch it; anyone else sees the switch read-only with "Only the space owner can do that" (the
  bot's `userId` is in the bot contract for this). Team to Own takes `bots/<id>/` and its
  browser profile to the Own computer's home; Own to Team takes the Own computer's visible
  entries and profile back under `bots/<id>/`. `shared/` and the Own computer's hidden entries
  (`.config`, caches) stay. Order: copy, check sizes, change the bot's computer (in one
  transaction with a check that the switch still holds its lease, and a lapsed
  `dozo-computer-switch-due` row in the lease table), delete what it left, drop that row. A copy
  or change that fails takes the copy back and leaves the bot where it was ("Couldn't move this
  bot's files. Try again."). Whatever a switch left undone (its process died, its lease lapsed,
  a computer could not be cleared) is finished by a one-minute sweep in the API that reads the
  lapsed `dozo-computer-switch*` rows: it clears the Team Computer of a bot on its Own computer,
  and clears a bot's Own computer only where the due row says its computer had changed (so a
  copy cut short before that, which stays private there, is never mistaken for a leftover). A
  running computer is changed through its own commands; a stopped one on the server while its
  `maintenanceId` holds it from starting (the computer shows as starting meanwhile), so nothing
  is started for the move. The size check walks each folder once and stops at 64 levels or a
  million entries. Files over 12 MB (what a running computer takes in one write) refuse the
  switch before anything is copied, naming the first three and counting the rest. Cache folders
  the save policy skips (`node_modules`, `.cache`, browser caches) are not copied and are
  deleted with the rest. Only kinds that declare `movesBotFiles` (Docker) move files; others
  refuse a switch once they have run. Folders left on a Team Computer by switches before this
  change stay there.
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
- Routine quiet hours (Settings > General, `packages/adapters/src/dozo-quiet-hours.ts`): a routine
  due inside the account's range waits until it ends and then runs once, keeping its due time, so
  it shows as late. A scheduled run missed by more than 12 hours (a server that was off) is skipped
  without a note in the chat; only the server log names it (`routine.missed`). Quiet hours stop
  routines from starting, not a run already going or its one retry, and webhook, email and chat
  triggers run at once. The mobile app sets them in General too, in the account's timezone,
  which it does not show. The server keeps up to four ranges, each on its own days and belonging
  to the day it starts on (Friday 22:00-07:00 covers Saturday morning), their union in force;
  ranges that leave no minute of the week outside them are refused. `hours` in the API is the
  first range, for clients that set one range only: saving `hours` changes that range's times and
  keeps its days and the other ranges (one range on every day when there is none), and `null`
  turns all of them off. The previous release's single-range table is always written with the
  first range's times in the same save, so while a deploy or a rollback runs that release, its
  range gone reads as quiet hours off and other times as a change to the first range.
  `dozoQuietHours.suggest` (at most 5 a minute per account, per API process) fits ranges to the
  hours of the last four weeks in which the account wrote least (only messages it wrote itself,
  in the app or from a linked messaging app, counted per local hour; nothing is kept), or answers
  null when there is too little or no clear pattern. Known limit: a message after midnight counts
  for the calendar day it was written on, so a Friday night out shows as Saturday activity, while
  a range belongs to the day it starts on.
- Generated images and videos leave one usage record each (`packages/adapters/src/dozo-media-usage.ts`,
  provider `media`, model `generate_image` or `generate_video`), so they show in usage. The media
  service reports no price, so their cost reads as unknown; nothing is charged against model credit.
- Uploaded avatars (`packages/adapters/src/dozo-avatar-upload.ts`): a new picture from the web or
  mobile app, or a data image a bot passes to `update_bot`, is kept only when its first bytes are
  the PNG, JPEG, GIF or WebP its header names, and it is stored as the server's own 256 px WebP
  re-encoding. Values already stored, imported bots and exports are not re-checked.
- Avatars from a description (`apps/api/src/dozo-avatar-generate.ts`, procedures
  `dozoAvatarGenerate.status` and `.generate`): the deployment's image service draws a square
  picture, which goes through the same checks and 256 px WebP re-encoding as an upload and comes back
  as a data image; nothing is saved until the person saves it as an avatar. It is offered only when
  the server has an image service that draws images and, on a server that bills, only to an
  organization that pays (Free is refused, as a bot's own image tool is). Each try leaves one usage
  record (provider `media`, model `avatar_image`, no run or bot, cost unknown), written before the
  service is called; if it cannot be written the call does not start. So a try that is cancelled,
  times out (2 minutes), fails or returns something unusable still counts, since the service may
  have charged. The limit is 20 in any sliding 24 hours per person, across all their Spaces
  together, counted from those records (an index on person and time serves it), and a person has
  one picture being drawn at a time, held by a lease, so two at once cannot both pass the count or
  be billed twice. The description is never logged or kept. The offline image provider
  (`MEDIA_GENERATION_PROVIDER=fake`) returns a valid 8x8 PNG (`dozo-fake-image.ts`), so the feature
  runs on a local server; `dozo-avatar-generate.postgres.test.ts` checks the count and the lease on
  a real database.
- Daily digest (Settings > General, web and mobile; off by default;
  `packages/adapters/src/dozo-daily-digest.ts`): a routine on the chosen bot that, at the chosen
  hour in the account's timezone, writes one message in that bot's chat from saved data, with no
  model run: the account's runs in that Space started the local day before (done and failed per
  bot), its runs waiting for an answer, and its timed routines still due today. A day with none of
  these writes nothing. It is a routine, so quiet hours and the 12-hour catch-up apply, and it
  shows in the bot's Routines list, where deleting it turns the digest off. A test run there, or
  an edit to its prompt, runs the model with that prompt instead. Text is English or Turkish, by
  the account's language. No meeting preparation: reading a calendar means calling one
  connector's own tools, which shared code may not name.
- One-time waits (`packages/adapters/src/dozo-wait.ts`): `schedule_create` with a watch and
  `waitMinutes` (5 minutes to a week, at most 10 going per bot) wakes the bot once in that chat, at
  the first change or at the deadline, then ends; no model runs in between and the routine's
  wakeup job carries it across restarts. It is a routine, so the user sees and stops it in the
  bot's Routines list (web and mobile). A deadline missed by more than 12 hours ends it without a
  run, as a missed one-time routine does. A wait for a set time is the existing one-shot reminder.
  A wait that cannot start is refused before the approval card; the per-bot count and the insert
  share an advisory lock. `dozo-wait.postgres.test.ts` checks it on a migrated database
  (`VERIFY_DATABASE=1`, `DATABASE_URL` of the runtime login); the unit gate skips it.
- Known upstream defect, not caused by the rename: the first boot of a new team's computer can answer
  500 "computer home is not usable by uid 1000" on macOS Docker Desktop or Colima bind mounts. Retry
  succeeds. It is upstream's ownership check. The e2e suite allows it on that first start (and
  does not require it). On the Linux host of `dozo/deploy/`, where the home is a named volume, the first
  boot succeeded.
- With a mail provider, password sign-up gives no session until the address is verified, and an
  unverified account cannot sign in with its password (`dozo-verify-email.ts`). A link opened
  without a session is held by that browser, and signing in there with the password finishes the
  verification. A sign-in code proves the address too, but drops an unverified account's earlier
  logins, its password included (upstream's protection). Without a provider nothing changes. Old
  unverified accounts keep their open sessions and are asked to verify at their next password
  sign-in. A passkey sign-in on an old unverified account is not closed; a new account cannot have
  one, since a passkey is added only with a session.

## Licence and attribution

The fork's own files are under the Elastic License 2.0 (`dozo/LICENSE`); upstream's files stay under
the Apache License 2.0 (`LICENSE`). `dozo/NOTICE` says which file is which and from which commit.
Dozo is source available, not open source: do not describe it as open source. Upstream's `NOTICE`
stays untouched; our addendum is `dozo/NOTICE`. Dozo claims no right to the Rakazo name or marks, and does not reuse upstream's logo or
mascot. Dozo's name is not yet cleared as a trademark (see `dozo/LAUNCH-CHECKLIST.md`).
