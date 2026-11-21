# Hosted login end to end

Sign-in on a computer's Dozo server with the hosted account
(`packages/auth/src/dozo-hosted-login.ts`), with nothing stood in: the hosted server and the
computers' servers are the real server bundle (API, web app, Postgres, migrations), and a real
browser (Playwright's Chromium) clicks through the pages. It runs in one Docker container on the
machine and touches no live service.

```sh
dozo/e2e/hosted-login/run.sh                                   # the release in run.sh
DOZO_E2E_MANIFEST=<dist>/manifest.json dozo/e2e/hosted-login/run.sh   # a bundle built here
```

A local build: `dozo/server-bundle/build.sh <out>`, then in `node:24.22-slim`
`node dozo/server-bundle/runtimes.mjs <out>/dist linux-x64 && node dozo/server-bundle/manifest.mjs
<out>/dist file:///dist` (as `smoke.sh` does). Last line `HOSTED LOGIN E2E: PASS|FAIL`; exit 0 or
2. CI runs it after the server bundle's smoke test (`dozo-server-bundle`, job Smoke linux-x64).

The hosted server (`hosted.sh`) answers as `http://localhost:6173`, a computer's server as
`http://127.0.0.1:5173` (and a second one on 5273), so the browser keeps their cookies apart as
it does for a real site. The computer's server starts with the bundle's own `run.sh` and
`DOZO_HOSTED_LOGIN_ISSUER`, as the desktop app starts it. The keys are made for the run, in the
form the deploy README makes them, and kept nowhere.

What it goes through, in order, each step on the state the one before left:

1. A new computer: its sign-in page has only the one button; the hosted page sends a signed-out
   person to sign in, they sign up there, come back to the page that names the account and asks
   to agree, agree, and the computer is signed in as that account.
2. Signed out and in again: the same local user; the session lasts 90 days.
3. A key change in three deploys (overlap key published, keys swapped, overlap removed): every
   sign-in goes on.
4. The hosted server's clock ten minutes behind (libfaketime, the API only): the computer says to
   check its date and time.
5. The hosted account deleted: another hosted account is refused, `dozo-local-account.mjs
   unlink-hosted` runs against the running server, and that account then signs in as the same
   local user.
6. A computer from before hosted sign-in, with a password account: restarted with the issuer it
   opens, the password still signs in, Settings > General offers "Dozo account" > Link, the
   hosted page links it, the password sign-in then answers 404, and the hosted sign-in reaches
   the same user.

`serve` keeps a hosted server and a new computer up for the desktop window test
(`dozo/desktop/tests/hosted_login_window.sh`), which joins this container's network.
