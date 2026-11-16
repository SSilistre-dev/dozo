# Dozo e2e

A small Playwright suite for what the fork changes, run against the branded Docker stack.
Upstream's own web e2e (`apps/web/e2e`) is left to CI and is not touched or run here.

## Run
```
make up        # stack must answer 200 at DOZO_E2E_BASE_URL (default http://127.0.0.1:5173)
make e2e       # exit 0 pass, 2 on any failure, unreachable stack or zero tests run
```
Needs only Docker and curl; nothing is installed on the host. `run.sh` runs the official
Playwright image (tag = the version pinned in `apps/web/package.json`), installs
`@playwright/test` inside the container, and deletes `dozo/e2e/.out/` when it ends, pass or fail.
Options: `DOZO_E2E_BASE_URL`, `DOZO_E2E_KEEP=1` (keep traces/screenshots/video in `.out/`),
`DOZO_E2E_ARGS="shell.spec.ts"` (Playwright arguments), `DOZO_E2E_SUITE=<dir>` (another suite dir).

## Browser path
Docker Chromium, used for the passing run (about 12 s of tests, about 1 min with image start and
install). The app only accepts its configured origin (`127.0.0.1:<port>`), so the browser must see
that name. Linux: `--network host`. Docker Desktop (macOS): a 1-line TCP forwarder inside the
container relays `127.0.0.1:<port>` to `host.docker.internal`. A host-browser CDP fallback is not
built, because the Docker browser did not crash here.

## Covered
- `brand.spec.ts`: title, visible text, alt/title/aria-label/placeholder and links hold no
  Rakazo/getrakazo/elie222 on sign-in, sign-up, forgot-password, 404 and onboarding, in dark and
  light; favicon and manifest name.
- `shell.spec.ts`: sign up, sign out, sign in again; no corrupted localStorage key.
- `local-models.spec.ts`: no "Run on this computer" while the published list is empty; the
  provider list still opens. The populated case is `test.fixme` (delete its first line to enable).

## Not covered
- Home, Settings and account Models settings: the app shell needs a connected model and the
  stack has none, so those parts print `NOT COVERED` and the onboarding step is checked instead.
- Upstream's e2e, the desktop app, mobile.
- Rate limit: the stack allows 10 sign-up/sign-in calls per 15 minutes per address; one run uses 4,
  so a third run inside 15 minutes fails with "sign-up rate limited".
