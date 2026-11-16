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

Host: `bash`, Docker, `curl` and the standard shell tools (`sed`, `awk`, `grep`, `find`, `readlink`,
`ln`). No Node or Playwright on the host; nothing is installed. The stack must be up with its
container `dozo-api-1` (the script reads its network and probes the model stub from it), and the
stage it was built from must be complete (`stage.complete` and `src/apps/web/src/App.tsx`), because
the inventory check reads the branded web source from it.

Exit 2 covers every failure: no `docker` or `curl`, another run in progress, a missing stage, an
unreachable stack, no `dozo-api-1`, the model stub not starting or not reachable from the api, a
failed `npm install`, zero tests run, a failed test, a declared key nobody visited, or an interrupt.

`run.sh`:
1. takes the lock `/tmp/dozo-e2e-<uid>.lock` on the host: a symlink to the owner's pid, created
   atomically. A second run while the owner is alive is refused (exit 2); a dead owner's lock is taken
   over. It is removed when the run ends.
2. starts `model-stub.mjs` (below) in a throwaway `node:24-slim` container (`DOZO_NODE_IMAGE`) on the
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
| `DOZO_NODE_IMAGE` | `node:24-slim` | Image of the model stub |
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
  - `setup` (`auth.setup.ts`): signs up once, connects the model, seeds two bots, saves the session.
    Its teardown is `roundtrip`.
  - `crawl-light` and `crawl-dark` (`crawl.spec.ts`, `local-models.spec.ts`): the same surfaces in both
    themes, using the saved session; they depend on `setup`.
  - `roundtrip` (`roundtrip.spec.ts`): runs last even after failures; signs in and out, which ends the
    saved session, and checks the stored keys were not corrupted by the rename.
  - `inventory` (`inventory.spec.ts`): the inventory check and its own tests, no browser session.
  - `scanner` (`scanner.spec.ts`): tests the scanner against planted names.
  - `web-manifest` (`manifest.spec.ts`): the favicon and web manifest are served and branded.
  - `local-models.spec.ts` checks that the local-model panel is absent while the published model list
    is empty and the upstream form still works; its second test is `fixme` until a list is published.
- `surfaces.ts` + `surfaces/*.ts`: the crawl as data. A surface is a `name`, a `group`, `covers`
  (inventory keys) and `reach(ctx)`; `ctx.scan(label)` scans the current state. Optional: `once` (light
  theme only, it creates data), `slow` (longer timeout), `signedOut` (starts without a session),
  `blankByDesign` (a reason; the screen renders nothing on purpose, so the content floor skips it),
  `expect5xx` (server errors the surface is expected to meet, each with its reason; `mustOccur` fails
  the surface the day the defect is gone). The known first-start defect (`dozo/README.md`, Status and
  known limits) is one such entry.
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
    attribute and link values (`[alt]`, `a[href]`, `meta[...]`, a URL passed to `window.open`). Never
    in the title, visible or hidden text, input values, toasts, the clipboard or downloads.
- `inventory.ts` + `inventory.spec.ts`: read the router (`App.tsx`), `SETTINGS_SECTIONS`,
  `OVERLAY_KEYS` and the onboarding steps from the app source and FAIL when one is neither covered
  by a surface nor in `SKIPS` (`surfaces.ts`) with a reason, or when `surfaces.ts` names one the
  app no longer has. That is what keeps "everywhere" true after an upstream merge.
- `fixtures.ts`: what makes a visit count. After `reach`, the app's last-resort error screen must not
  be showing; the screen must show at least 10 characters of text (it waits up to 5 s for the app to
  draw before failing with the count); the title must contain "Dozo"; no server error (5xx) may occur
  except those a surface expects; and the scan must find no leak.
- `coverage-reporter.ts`: prints the coverage table at the end of every run: per surface (visited in
  light and dark, strings scanned, brand hits), per inventory key, totals, brand leaks, server
  errors seen, outgoing hosts, and what cannot be reached and why (`NOT_REACHABLE`). A key that a
  surface declares in `covers` but that no surface visited FAILS the run; this is only checked when
  every surface ran, so a filtered run (`DOZO_E2E_ARGS`) is not judged on it.

## Rate limit

The auth endpoints allow 10 credential calls per 15 minutes (`packages/auth/src/index.ts`). A run
spends three: the one sign-up, one wrong password, one sign-in. The suite reports a 429 with its
retry-after if the limit is hit.

## Not covered

See `NOT_REACHABLE` in `surfaces.ts` (also printed by every run): e-mails (no mail server), desktop
only screens, tool-call cards (the model answers with text only), voice, real integrations, a
second account, admin and billing with real data, the mobile app.
