# Dozo e2e

A Playwright suite for what the fork changes, run against the branded Docker stack. It crawls the
whole web app (every route, settings section, overlay and onboarding step the app's source lists)
and scans every screen it reaches for the upstream name, upstream links and copied text.
Upstream's own web e2e (`apps/web/e2e`) is left to CI and is not touched or run here. This suite is
not part of `make qa` or of CI.

## Run

```
make up        # the stack must answer 200 at the base URL (below)
make e2e       # exit 0 pass, 2 on anything else
```

Host: `bash`, Docker, `curl` and the standard shell tools (`sed`, `awk`, `grep`, `find`, `ps`,
`mkdir`). No Node or Playwright on the host; nothing is installed. The stack must be up with its
api container of the compose project `dozo` (found by its labels; the script reads its network and probes the model stub from it), and the
stage it was built from must be complete (`stage.complete` and `src/apps/web/src/App.tsx`), because
the inventory check reads the branded web source from it.

Exit 2 covers every failure: no `docker` or `curl`, another run in progress, a missing stage, an
unreachable stack, no running api container, the model stub not starting or not reachable from the api, a
failed `npm install`, zero tests run, a failed test, a declared key nobody visited, or an interrupt.

`run.sh`:
1. takes the lock `${TMPDIR:-/tmp}/dozo-e2e-<uid>.lock` on the host: a directory made with `mkdir`
   (atomic) that holds `owner`, the pid and start time of the run. A second run while the owner is
   alive is refused (exit 2). A lock whose owner is gone, or whose pid now belongs to another
   process (the start time differs), is taken over; two runs that find the same stale lock still
   start exactly one, and a lock with no owner file is taken over after 2 seconds. The lock code is
   shared with the stage lock (`dozo/docker/lock.sh`). A directory of another user at that path is refused. It is removed when the
   run ends, also on INT and TERM. A `.takeover.*` directory next to it is left only if a run died
   in the middle of a takeover: remove it.
2. starts `model-stub.mjs` (below) in a throwaway `node:24.22-slim` container (`DOZO_NODE_IMAGE`) on the
   stack's network;
3. runs the official Playwright image `mcr.microsoft.com/playwright:v<version>-noble`, where
   `<version>` is the first `@playwright/test` version in `apps/web/package.json` (upstream's pin; the
   suite's own `package.json` pins nothing). It mounts the suite and the staged web source read-only,
   installs `@playwright/test@<version>` inside the container and runs Playwright;
4. at the end, pass or fail, removes its containers (label `dozo.run=e2e-<pid>`: `dozo-pw-e2e-<pid>`,
   `dozo-e2e-model-<pid>`, `dozo-e2e-npm-<pid>`), empties `dozo/e2e/.out/` (the directory stays;
   it is also emptied at the start) and removes `dozo/e2e/node_modules`.

The installed modules and npm's download cache live in the Docker volume `dozo-e2e-npm`, nothing on
the host: modules in `mods/<hash of the package spec>`, so a new Playwright version installs into a new
directory and other ones are removed. Drop everything with `docker volume rm dozo-e2e-npm`. If the
volume cannot be set up the run goes without a cache.

Options:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOZO_E2E_BASE_URL` | `http://127.0.0.1:<port>` | Where the stack answers. `<port>` is, in order: `DOZO_WEB_PORT` in the stage's `dozo.env`, then `DOZO_WEB_PORT` in your shell, then 5173 (the env file wins, as for the build) |
| `DOZO_STAGE_DIR` | `dozo/.stage` | The stage the stack was built from |
| `DOZO_NODE_IMAGE` | `node:24.22-slim` | Image of the model stub |
| `DOZO_E2E_KEEP` | off | `1` keeps `.out/` (traces, screenshots, `results.json`, the coverage JSON) |
| `DOZO_E2E_ARGS` | empty | Playwright arguments, for example `--project=crawl-light` |
| `DOZO_E2E_SUITE` | this directory | Another suite directory |
| `DOZO_E2E_REUSE_DIR` | unset | Development: a directory with `auth.json` and `world.json`; skips the sign-up |

`run.sh` itself sets `DOZO_E2E_OUT`, `DOZO_E2E_SRC` and `DOZO_E2E_MODEL_URL` inside the container;
do not set them.

The app only accepts its configured origin (`127.0.0.1:<port>`), so the browser must see that name.
Linux: `--network host`. Docker Desktop (macOS): a TCP forwarder inside the container relays
`127.0.0.1:<port>` to the stack's `web:5173`. Through it a document request occasionally stalls, so
navigations retry (`gotoStable` in `ui.ts`).

## The model

A user cannot leave onboarding without a connected model, and no real model or key is used.
Upstream's emulator (`packages/testkit/src/model-emulator.ts`) is not usable standalone: it is a
TypeScript module of a pnpm workspace, it answers only `POST /v1/chat/completions`, it has no
`/v1/models` (the connect form's "Find models" needs it) and it fails any request that is not the
next scripted step, while a bot also makes background calls. So `model-stub.mjs` (Node built-ins
only; tested by `model-stub.test.mjs`, which `make olc` runs) lists one model and answers every
completion with one canned reply, streamed. The setup project connects it through the real
onboarding step as an "OpenAI-compatible" server, so the real connect flow is exercised and the
worker's greeting comes from it. Its address is a private IP literal (the app refuses a hostname
that resolves to a private address).

## Structure

- `playwright.config.ts`: one worker, no retries, `forbidOnly`; 90 s per test, 15 s for assertions
  and actions, 30 s for navigations; trace, screenshot and video kept on failure; reporters `list`,
  JSON (`.out/results.json`) and `coverage-reporter.ts`. Projects:
  - `setup` (`auth.setup.ts`): signs up once, connects the model, seeds two bots, saves the session
    (without the stored appearance, so each crawl project sets its own theme).
    Its teardown is `roundtrip`.
  - `crawl-light` and `crawl-dark` (`crawl.spec.ts`, `local-models.spec.ts`, `look.spec.ts`): the same
    surfaces in both themes, using the saved session; they depend on `setup`.
  - `roundtrip` (`roundtrip.spec.ts`): runs last even after failures; signs in and out, which ends the
    saved session, and checks the stored keys were not corrupted by the rename.
  - `inventory` (`inventory.spec.ts`): the inventory check and its own tests, no browser session.
  - `scanner` (`scanner.spec.ts`): tests the scanner against planted names.
  - `web-manifest` (`manifest.spec.ts`): the favicon and web manifest are served and branded.
  - `flows` (`flows/*.spec.ts`): the scenarios (below); depends on `setup` only.
  - `look.spec.ts` checks the Dozo look where the app shows it: the theme file is loaded and follows
    the appearance, bots are drawn as Dozo characters (sidebar, chat, bot panel, sign-in), the hooks
    of `dozo-shell.css` still match (pills, wordmark, pattern, tinted row), and a first visit is dark.
    Every crawled surface also fails when it shows an element of upstream's avatar drawings
    (`UPSTREAM_AVATAR_ART` in `fixtures.ts`).
  - `local-models.spec.ts` checks that the local-model panel is absent while the published model list
    is empty and the upstream form still works; its second test is `fixme` until a list is published.
- `surfaces.ts` + `surfaces/*.ts`: the crawl as data. A surface is a `name`, a `group`, `covers`
  (inventory keys) and `reach(ctx)`; `ctx.scan(label)` scans the current state. Optional: `once` (light
  theme only, it creates data), `slow` (longer timeout), `signedOut` (starts without a session),
  `blankByDesign` (a reason; the screen renders nothing on purpose, so the content floor skips it),
  `expect5xx` (server errors the surface is expected to meet, each with its reason; `mustOccur` fails
  the surface the day the defect is gone). The known first-start defect on macOS (`dozo/README.md`,
  Status and known limits) is one such entry, without `mustOccur`: it does not happen on Linux.
- `scan.ts`: what is scanned for `rakazo`, `getrakazo`, `elie222` and two upstream identifiers, the
  Discord invite code `RWwKa2Sn7h` and the App Store id `id6801531099` (any capitalisation): document
  title, visible text, hidden text, `alt`, `title`, `aria-label`, `aria-description`, `placeholder`,
  `aria-placeholder`, `href`, `src`, `action`, meta tags, input and textarea values (not passwords), and
  text recorded while the test ran: toasts, dialogs, menus, tooltips, strings written to the
  clipboard, URLs passed to `window.open`, and downloaded files (name and bytes, under 20 MB).
  Outgoing link hosts are listed in the report. Allowed:
  - the documented attribution phrases ("fork of Rakazo", "Based on Rakazo", "forked from Rakazo"),
    anywhere;
  - the deliberate identifiers (`@rakazo/*`, `RAKAZO_*`, `x-rakazo-*`, `rakazo://`), only inside
    carriers a person does not read (`href`, `src`, `action`, `meta[...]`, a URL passed to
    `window.open`). Never in the title, visible or hidden text, input values, `alt`, `title`,
    `placeholder` or `aria-*` attributes, toasts, the clipboard or downloads.
- `inventory.ts` + `inventory.spec.ts`: read the router (`App.tsx`), `SETTINGS_SECTIONS`,
  `OVERLAY_KEYS` and the onboarding steps from the app source and FAIL when one is neither covered
  by a surface nor in `SKIPS` (`surfaces.ts`) with a reason, or when `surfaces.ts` names one the
  app no longer has. That is what keeps "everywhere" true after an upstream merge.
- `fixtures.ts`: what makes a visit count. After `reach`, every `route:<path>` key the surface
  declares must have been shown: some URL the page had during `reach` matches the route pattern
  (`:param` is one segment, `:param?` optional, `*` anything; `matchesRoute` in `logic.ts`). A
  surface whose route redirects names where it ends with `landsOn: { "route:/": { path, reason } }`
  (the pattern is accepted in addition to the key's own; used for the signed-out root and the app
  root). Settings sections and overlays are not checked by the runner: their `reach` already
  asserts a marker (`data-settings-section` in `openUserSettings`, the overlay's close button), but
  the surfaces end in other states, so one generic check would be wrong. The app's last-resort
  error screen must not be showing; the screen must show at least 10 characters of text (it waits up to 5 s for the app to
  draw before failing with the count); the title must contain "Dozo"; no server error (5xx) may occur
  except those a surface expects; and the scan must find no leak.
- `coverage-reporter.ts`: prints the coverage table at the end of every run: per surface (visited in
  light and dark, strings scanned, brand hits), per inventory key, totals, brand leaks, server
  errors seen, outgoing hosts, and what cannot be reached and why (`NOT_REACHABLE`). A key that a
  surface declares in `covers` but that no surface visited FAILS the run; this is only checked when
  every surface ran, so a filtered run (`DOZO_E2E_ARGS`) is not judged on it. The decision itself
  is `declaredKeysVerdict` in `logic.ts`.
- `logic.ts` + `logic.test.mjs`: the pure decisions above (route matching, the missed-route check,
  the coverage verdict), with no imports. Node's test runner checks them offline; `make olc` runs
  every `dozo/e2e/*.test.mjs`. The reporter and the runner themselves need Playwright and run only
  in `make e2e`.

## Scenarios (`flows/`)

The crawl proves every screen opens and carries no upstream name; the scenarios in `flows/*.spec.ts`
prove the features work. Project `flows` (depends on `setup` only), light theme, the setup's account unless a
scenario makes its own (`flows/accounts.ts`: `newAccount`, the admin's `adminBrowser`). Every
scenario (`flows/flow.ts`):

- fails on a console error, an uncaught page error, a request that failed (not one the page
  dropped itself, nor `ERR_NETWORK_CHANGED`: the browser shares the host's network, which changes
  whenever a container on the machine starts or stops) or a 4xx/5xx answer, unless the scenario allows
  that exact answer with a reason (`guard.allow`). A known defect is allowed with a reason that
  starts with `FINDING:`, so it is listed, not hidden;
- saves its last screen to `dozo/.stage/e2e/shots/<project>--<title>.png` (run.sh copies it out
  before it empties `.out/`);
- waits for conditions, never a fixed time, and puts back what it changed (a quota, an announcement,
  the approval mode), so three runs in a row start the same.

The admin: build.sh writes `RAKAZO_ADMIN_EMAILS=admin@dozo-e2e.test` into a stage's env file that
names no admin; run.sh signs that address up through the auth API, marks it verified in the
database and passes it to the container (`DOZO_E2E_ADMIN_EMAIL`/`_PASSWORD`, a local test account).
A stack started before that change needs `make up` again. run.sh also clears the auth rate limit's
rows, so repeated runs are not refused (only on this local stack).

The model stub calls a tool when the newest user message holds `[e2e-tool:<name> <args>]` (args as
JSON or `b64:<base64 JSON>`) and the request offers that tool, then answers its result with a fixed
line; the chat scenario uses it for a tool call that waits for the owner's approval.

There is no payment provider on this stack: billing's server answers are faked in the browser from
the server's own plans (`fakeBilling`, prices read from `dozoAdmin/plans/list`, never written in the
suite); the checkout is recorded and answered with the `?billing=canceled` return. Free access
grants exist only on a billing server, so the account reports billing (`reportBilling`) and the four
calls are answered in the browser too; without billing the admin page does not list the section.

## Coverage

What is checked where, per surface. "crawl" = opened and scanned (`surfaces/`), "flow" = a scenario
does the feature end to end (`flows/`), "flow (faked)" = a scenario with the server's answer faked
in the browser because this stack lacks the provider, "live" = `make canli` only. 48 inventory keys
(routes, settings sections, overlays, onboarding steps; the inventory check fails on a new one) plus
the features below: 37 surfaces in the table, 35 checked, 2 not (each row is one surface).

| Surface | Scenario | Status |
| --- | --- | --- |
| Sign-up | real form, Turkish; lands on the model step | flow; live |
| Sign-in / sign-out | sign out from the account menu, sign in again | flow |
| Sign-in errors | wrong password, address already registered: Turkish lines | flow; live |
| Forgot / reset password | request (this stack says recovery is not configured), invalid token form | flow; live (form) |
| Onboarding: model step | connect the offline model (setup); every provider's form | crawl; setup |
| Onboarding: "Later" | new account goes on to the app with its first bot | flow; live |
| Onboarding: survey, first bot | opened | crawl |
| Chat | message, the model's reply | flow; crawl |
| Chat: tool call | the call waits on an Allow card in "ask" mode, runs after Allow, the model sees the result | flow |
| Chat: message actions, composer menus, slash, mention | opened | crawl |
| Bots | create, rename, delete | flow; crawl (create, panel, avatar, settings) |
| Scheduled task (routine) | create with a schedule, saved, delete | flow; crawl (editor) |
| Apps / integrations window | opens, switches category, every logo loads (live: from our own host) | flow; live; crawl |
| Skills, templates, MCP overlays | opened | crawl |
| Settings: each section | general, models, approvals, vault, memory, voice, labs, usage, organization open without error | flow; crawl (every popup) |
| Settings: Models | model roles, provider list, connection forms; live: responses counted | crawl; live |
| Settings: billing | the server's plans and prices, monthly and yearly | flow (faked); live |
| Billing: landing plan pick | `?plan=premium_plus&period=year` → Billing opens with it, checkout asks for it | flow (faked) |
| Billing: `?billing=canceled` | Billing opens again, the address is cleaned | flow (faked); live |
| Billing: payment page | opens with the right plan and amount, no card entered | live |
| Plan limit: Free computer | waking is refused, the plan line and Upgrade | live |
| Plan limit: shared space | a full space refuses the upload with its line | flow (faked) |
| Computer | start from the bot panel, stop from the admin list, asleep again | flow; crawl (full window, teach) |
| Admin: members | search, plan filter, give Premium, take it back, suspend, status filter, delete | flow |
| Admin: site settings | announcement saved, a member sees the line, cleared | flow |
| Admin: plans | a quota changed and put back | flow |
| Admin: free access | create, edit, delete | flow (faked) |
| Admin: billing, funnel | counts shown, the three periods switch | flow |
| Admin: plugins | opened | crawl |
| Admin: a member is refused | `/admin` answers like an unknown address | crawl |
| Admin, live | every section opens read only (optional admin mode) | live |
| 404 | signed in and signed out | flow; crawl; live |
| Spaces, groups, invite, board, artifacts, shared pages, callbacks | opened (unknown ids) | crawl |
| Dead links | `dozo.example`, `OWNER/`, own links answering | live |
| `/assets` caching | public, a year, immutable; the HTML is not | live |
| Performance budgets | cold first paint, Apps click to window and first tile, Models responses | live (warns only) |
| Settings: updates | desktop app only | not checked |
| E-mails, voice, real integrations, passkeys, mobile | see Not covered | not checked |

## Live smoke run (`make canli`)

`CANLI_URL=https://... make canli` (no default address, so it never runs against the live site by
accident) runs `canli.sh`: the Playwright image with the same module cache, `--cpus 3 --memory 6g`,
the browser in Turkish, `canli/playwright.config.ts`. Only safe steps, limited to an account it
makes itself:

- `canli/public.spec.ts`: no account. Cold first paint of `/sign-in`, the wrong-password line, the
  reset form, the 404 page, placeholder links (`dozo.example`, `OWNER/`) and our own links on the
  public pages (each must answer), `/assets` cache headers.
- `canli/account.spec.ts`, in order: sign up `info+dozo-probe<random>@ssilistre.dev` → model step →
  "Daha sonra"; the same address again is refused in Turkish; cold first paint of `/app`; the Apps
  window (time to window and first tile, every logo loaded from our own host); Settings → Models
  (responses counted); Billing and `?billing=canceled`; the payment page opens with the plan's
  name and the amount the server's own status gives (no card entered); Free's computer refusal;
  then the account is deleted with its own session and proven gone (the same sign-in answers 401,
  no session left). A failed step does not skip the next ones. The global teardown
  (`canli/cleanup.ts`) is the finally step: whatever failed, an account the run made is deleted
  there; what happened is the report's "Temizlik" line.
- `canli/admin.spec.ts`: only with `DOZO_CANLI_ADMIN_EMAIL` and `DOZO_CANLI_ADMIN_PASSWORD` in the
  environment (passed to the container by name, never written to a file or a log). Signs in and
  opens every admin section read only. No picture of member lists is kept.

Every live scenario uses the scenario fixture above (console and 4xx/5xx watch, a picture) plus a
fence (`canli/live.ts`) that aborts and fails on any admin, grant or billing-portal call whose name
changes something. No payment, no ban, no admin action. A billing scenario skips itself on a server
that does not bill.

Output in `dozo/.stage/canli/`: `RAPOR.md`, `rapor.html`, `shots/`, `results.json`. The probe's
password and session files are removed when the run ends. Budgets (`canli/budgets.ts`, tested
offline by `canli-budgets.test.mjs`) only warn: the numbers come from one machine over the public
internet. The last line is `CANLI: PASS|FAIL (n senaryo)`; exit 0 or 2.

## Rate limit

The auth endpoints allow 10 credential calls per 15 minutes per address and path
(`packages/auth/src/index.ts`). run.sh clears the stack's rate-limit rows before each run; a run
spends about eight sign-ups and five sign-ins (the admin signs in once, its session is reused). The
suite reports a 429 with its retry-after if the limit is hit. `make canli` spends two sign-ups and
up to three sign-ins on the live site.

## Not covered

See `NOT_REACHABLE` in `surfaces.ts` (also printed by every run): e-mails (no mail server), desktop
only screens, voice, real integrations, passkeys and social sign-in, the mobile app. Tool calls,
admin pages with real data and billing's screens are now covered by the scenarios above.
