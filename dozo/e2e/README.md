# Dozo e2e

A Playwright suite for what the fork changes, run against the branded Docker stack. It crawls the
whole web app (every route, settings section, overlay and onboarding step the app's source lists)
and scans every screen it reaches for the upstream name, upstream links and copied text.
Upstream's own web e2e (`apps/web/e2e`) is left to CI and is not touched or run here.

## Run
```
make up        # stack must answer 200 at DOZO_E2E_BASE_URL (default http://127.0.0.1:$DOZO_WEB_PORT, else 5173)
make e2e       # exit 0 pass, 2 on any failure, unreachable stack or zero tests run
               # a second run while one is in progress is refused (exit 2)
```
Needs only Docker and curl; nothing is installed on the host. `run.sh`:
1. starts `model-stub.mjs` (below) in a throwaway `node:24-slim` container on the stack's network;
2. runs the official Playwright image (tag = the version pinned in `apps/web/package.json`),
   installs `@playwright/test` inside the container, mounts the suite and the web app's source
   read-only;
3. deletes `dozo/e2e/.out/` and removes both containers when it ends, pass or fail. npm's download
   cache is kept in the Docker volume `dozo-e2e-npm` (nothing on the host); drop it with
   `docker volume rm dozo-e2e-npm`.

Options: `DOZO_E2E_BASE_URL` (default: `DOZO_WEB_PORT`, else the port in the stage's `dozo.env`, else
5173), `DOZO_STAGE_DIR` (the stage the stack was built from; without its `src` the run stops, exit 2), `DOZO_E2E_KEEP=1` (keep traces, screenshots and the coverage JSON in
`.out/`), `DOZO_E2E_ARGS="--project=crawl-light"` (Playwright arguments),
`DOZO_E2E_SUITE=<dir>` (another suite dir), `DOZO_E2E_REUSE_DIR=<dir with auth.json and world.json>`
(development: skip the sign-up with a saved session).

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
only) lists one model and answers every completion with one canned reply, streamed. The setup
project connects it through the real onboarding step as an "OpenAI-compatible" server, so the real
connect flow is exercised and the worker's greeting comes from it. Its address is a private IP
literal (the app refuses a hostname that resolves to a private address).

## Structure
- `playwright.config.ts` projects: `setup` (signs up ONCE, connects the model, seeds two bots, saves
  the session) -> `crawl-light` and `crawl-dark` (the same surfaces, both themes) ->
  `roundtrip` (teardown of `setup`, so it runs last even after failures: sign in and out, which ends
  the saved session). Also `inventory` and `web-manifest`.
- `surfaces.ts` + `surfaces/*.ts`: the crawl as data. A surface is a name, a group, `covers`
  (inventory keys) and `reach(ctx)`; `ctx.scan(label)` scans the current state. `once` runs it in
  the light theme only (it creates data). `expect5xx` lists server errors a surface is expected to
  meet, each with its reason; `mustOccur` fails the surface the day the defect is gone.
- `scan.ts`: what is scanned for `rakazo`, `getrakazo`, `elie222` and the upstream store and chat
  identifiers `RWwKa2Sn7h` and `id6801531099` (any capitalisation):
  document title, visible text, hidden text, `alt`, `title`, `aria-label`, `placeholder`, `href`,
  `src`, meta tags, input values, and text recorded while the test ran: toasts, dialogs, menus,
  tooltips, strings written to the clipboard, URLs passed to `window.open`, and downloaded files
  (name and bytes). Outgoing link hosts are listed in the report. Allowed: the deliberate
  identifiers (`@rakazo/*`, `RAKAZO_*`, `x-rakazo-*`, `rakazo://`) inside attribute and link values
  only, and the documented attribution phrases ("fork of Rakazo", "Based on Rakazo", "forked from
  Rakazo").
- `inventory.ts` + `inventory.spec.ts`: read the router (`App.tsx`), `SETTINGS_SECTIONS`,
  `OVERLAY_KEYS` and the onboarding steps from the app source and FAIL when one is neither covered
  by a surface nor in `SKIPS` (`surfaces.ts`) with a reason, or when `surfaces.ts` names one the
  app no longer has. That is what keeps "everywhere" true after an upstream merge.
- `coverage-reporter.ts`: prints the coverage table at the end of every run: per surface (visited in
  light and dark, strings scanned, brand hits), per inventory key, totals, brand leaks, server
  errors seen, outgoing hosts, and what cannot be reached and why (`NOT_REACHABLE`).

## Rate limit
The stack allows 10 credential calls (sign-up, sign-in) per 15 minutes per address. A run spends
three: the one sign-up, one wrong password, one sign-in. Two consecutive runs fit.

## Not covered
See `NOT_REACHABLE` in `surfaces.ts` (also printed by every run): e-mails (no mail server), desktop
only screens, tool-call cards (the model answers with text only), voice, real integrations, a
second account, admin and billing with real data, the mobile app.
