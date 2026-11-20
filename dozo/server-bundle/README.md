# Local server bundle

The server a Free user runs on their own computer, without Docker: the API, the worker, the web
server and the migrations, as one archive that runs on plain Node next to a portable Postgres.
The desktop app downloads it on first start; it is not inside the app.

Upstream's `scripts/build-server-bundle.mjs` makes the archive and is not edited. `build.mjs` wraps
it: it runs it on the branded tree, leaves out the packages a local server never loads, repacks and
describes the result. Node and Postgres are not in the archive: `runtimes.json` pins their version,
first address and sha256 per platform (Node from nodejs.org, Postgres from the theseus-rs
`postgresql-binaries` releases, which carry `pg_dump` and their own libraries), and each release
carries its own copy of them (Runtimes, below).

| File                                 | What it is                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `build.mjs`                          | Builds the bundle for the machine it runs on from a branded staged tree                 |
| `build.sh`                           | Local linux-x64 build in Docker: stage, brand, then `build.mjs` in `node:24.22-slim`    |
| `manifest.mjs`                       | Joins the built bundles with `runtimes.json` into `manifest.json`                       |
| `runtimes.json`                      | Pinned Node and Postgres downloads                                                      |
| `runtimes.mjs`                       | Downloads the pinned runtimes and checks size and sha256, for a release's own copy      |
| `notices.mjs`, `licenses.json`       | Third-party notices written into the bundle, and which licences may ship                |
| `run.sh`                             | Reference start and stop (Linux, macOS): the start contract below, as a script          |
| `smoke.sh`                           | End-to-end test in a bare Debian container; last line `SERVER-BUNDLE SMOKE: PASS\|FAIL` |
| `fake-model.mjs`, `smoke-client.mjs` | The smoke test's local model and its user                                               |
| `*.test.mjs`                         | Offline tests of the notices and runtimes scripts, run by `make olc`                    |

## Build and test locally

```sh
dozo/server-bundle/build.sh <out>        # <out>/dist/dozo-server-linux-x64.tar.xz and .json
dozo/server-bundle/smoke.sh <out>/dist   # exit 0 pass, 2 fail
```

Both run in Docker with `--cpus 3 --memory 6g` and their own container names; neither touches the
local stack. `build.sh` keeps the pnpm store in the volume `dozo-server-bundle-store`
(`DOZO_PNPM_STORE_VOLUME`); remove it when done.

CI (`.github/workflows/dozo-server-bundle.yml`) builds linux-x64, macOS arm64 and x64 and Windows
x64, and runs the smoke test on linux-x64. Only linux-x64 has to pass. A `server-v*` tag, or a
manual run given a tag, puts the bundles, the Node and Postgres archives and `manifest.json` on a
draft release that is never marked latest; publishing the draft makes the addresses in the
manifest live.

## Manifest

```json
{
  "schema": 1,
  "version": "0.11.0",
  "platforms": {
    "linux-x64": {
      "server": { "url": "…/dozo-server-linux-x64.tar.xz", "sha256": "…", "size": 0 },
      "node": { "version": "24.22.0", "url": "…", "sha256": "…", "size": 0, "source": "…" },
      "postgres": { "version": "16.16.0", "url": "…", "sha256": "…", "size": 0, "source": "…" }
    }
  }
}
```

Platforms: `linux-x64`, `darwin-arm64`, `darwin-x64`, `win-x64`; one is missing when its build
failed. The version is upstream's with the fork's revision after it (`REVISION` in `build.mjs`,
`0.11.0-4`): raise it when what the fork adds changes, and tag the release `server-v<version>`.
The app reads the manifest of the server version it was built for
(`releases/download/<tag>/manifest.json`), downloads the three parts, checks size and sha256 before
unpacking, and unpacks Node and Postgres one folder down (their archives hold one top folder). The
server archive holds `rakazo-server/`; its `manifest.json` names the entrypoints: upstream's
four, `relay`, the relay host agent (`dozo/relay/agent/README.md`) as one file,
`dozo-relay-agent.mjs`, and the local commands below, one file each: `backup`
(`dozo-local-backup.mjs`), `account` (`dozo-local-account.mjs`) and `diagnostics`
(`dozo-diagnostics.mjs`). Plain Node runs them all.

## Runtimes

Each release holds the Node and Postgres archives `runtimes.json` pins, under the same file names,
and the manifest's `url` for both points there; `source` is where the archive was first published,
for reference only. The release job downloads them with `runtimes.mjs`, which refuses a file whose
size or sha256 differs from the pin, and `manifest.mjs` refuses to name a runtime the release
folder does not hold. So a new install needs nothing but our release: a publisher deleting a
release breaks no install. The copy is only from our release, with no fall-back to the first
address, because the app reads one address per part and both copies would be the same bytes.

The archives are passed on unchanged, which both allow: Node's licence (MIT, with the licences of
OpenSSL, ICU and the rest it carries, in `LICENSE`) and PostgreSQL's (the PostgreSQL Licence, in
`COPYRIGHT`) permit redistribution with their notices kept, and the `postgresql-binaries` build adds
its own permissive `LICENSE` and the Debian copyright file of every library it ships under
`dependency-notices/`. All of these stay inside the archives and are repeated in the notices.

## Third-party notices

`build.mjs` writes into `rakazo-server/`:

- `THIRD-PARTY-NOTICES.txt`: every package in pnpm's production list for the API, the worker and
  the web app (which covers what esbuild folds into the entrypoints as well as `node_modules`), with
  name, version, licence and the licence files it ships, then the licence files of this platform's
  Node and Postgres archives (downloaded and checked against `runtimes.json` for it);
- `apps/web/dist/third-party-notices.html`: the same text, which the web server serves. The app
  links it as "Licenses" at the end of the settings nav only where that page exists, so a hosted
  server shows no link (`apps/web/src/pages/dozo-settings-nav.tsx`);
- `LICENSE`, `NOTICE`, `LICENSE-DOZO` and `NOTICE-DOZO` (the repository's `dozo/NOTICE`).

`licenses.json` decides which licences ship. A package whose licence is in neither `allowed` nor
`review` fails the build (exit 2) with its name; read the licence before adding it to either list.
`review` licences pass and are printed and listed in the build's `.json` (`notices.review`) because
they carry conditions someone has to accept. `packages` corrects a licence pnpm reads wrong.

## Diagnostics

```sh
node rakazo-server/dozo-diagnostics.mjs --home <server folder> --out <file.tar.gz> [--lines 400]
```

Writes one `.tar.gz` (mode 0600, never over an existing file) holding `dozo-diagnostics/summary.json`
(server, Node and Postgres versions, platform, which processes run from `pgdata/postmaster.pid` and
`run/*.pid`, the folder's top-level names and sizes, every setting by name with secret values
shown only as `set` or `empty` and ports as numbers) and the last `--lines` lines (1 to 5000) of
each `logs/*.log`. Each line is cleaned first: every value of the secrets file (plain and
URL-encoded), then the logger's own redaction (fields that carry what someone wrote, emails,
tokens, keys, credentials in addresses, home paths), Postgres's `DETAIL`, `STATEMENT`, `QUERY`,
`CONTEXT` and `HINT` text, and any run of 32 or more token characters. The smoke test searches a
real report for the secrets, the account's email and the message sent.

One JSON line on stdout: `{"written": <path>, "files": <n>}`, or `{"error", "reason"}` with
`no-server` (no such folder), `failed` or `usage`; exit 0, 2 or 64. For an app menu item: pick the
file with a save dialog, run the command with `--out` set to it, then reveal the file.

## Start contract

Everything listens on 127.0.0.1. Secrets are random on first start and kept in a 0600 file in the
user's app folder: the Postgres owner and app passwords, `BETTER_AUTH_SECRET`,
`SCREEN_PROXY_SECRET`, `ENCRYPTION_KEY`, the single-account `RAKAZO_DESKTOP_STACK_TOKEN` (the
first account created is the only one) and `DOZO_RELAY_AGENT_KEY` (64 hexadecimal digits, given
to the API and to the relay agent, so the agent can ask for a paired phone's sign-in:
`dozo/relay/agent/README.md`, Phone sign-in; the API takes it out of its environment once read, so
its child processes never get it).

1. On Linux, check that `libssl.so.3` exists: Prisma's migration engine loads the system OpenSSL 3.
   Without it, stop with a message that says to install `libssl3`.
   Postgres's Linux build carries a `libstdc++.so.6` that needs glibc 2.36; its own programs need
   2.34. Where `postgres --version` fails as unpacked (Ubuntu 22.04 has glibc 2.35), set that file
   aside so the system's `libstdc++` (with `GLIBCXX_3.4.30`, as 22.04's has) is used.
2. First start: `initdb -U rakazo -A scram-sha-256 -E UTF8 --locale=C`, then `createdb rakazo`.
3. `pg_ctl start` with `-p <pg port> -c listen_addresses=127.0.0.1 -c unix_socket_directories=`.
4. `migrate`, run to completion, every start (a no-op takes about 1.6 s). Owner role for
   `DATABASE_MIGRATION_URL`; it creates the `rakazo_app` role that `DATABASE_URL` uses.
5. `api`, `worker` and `web` together; ready when the API's `/health` and the web page answer 200.
   The window opens the web address.
6. Stop in reverse: `web`, `worker`, `api` with TERM, then `pg_ctl stop -m fast`.

Each process runs from `rakazo-server/` with only these variables (plus `PATH` and `HOME`):

| Process     | Variables                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all         | `NODE_ENV=production`, `RAKAZO_ENV_FILE=none`                                                                                                                                                                                                                                                                               |
| migrate     | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `RAKAZO_DB_PACKAGE_DIR=packages/db`                                                                                                                                                                                                                                               |
| api, worker | `DATABASE_URL`, `DATA_DIR`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `RAKAZO_DESKTOP_STACK_TOKEN`, `BETTER_AUTH_URL` = `WEB_ORIGIN` = `API_URL` = the web address, `SANDBOX_PROVIDER=none`, `CONTENT_ENCRYPTION=off`, `WAKEUP_DRIVER=graphile`, `AGENT_RUNTIME=pi`, `MCP_ALLOW_PRIVATE_ENDPOINT=true` |
| api only    | `API_HOST=127.0.0.1`, `API_PORT`, `AUTH_PASSWORD_ENABLED=true`, `AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false`                                                                                                                                                                                                                |
| web         | `API_PROXY_TARGET` (the API address), `SCREEN_PROXY_SECRET`, `WEB_HOST=127.0.0.1`, `WEB_PORT`, `RAKAZO_DESKTOP_STACK_TOKEN`, `RAKAZO_IMAGE_TAG` (the bundle version)                                                                                                                                                        |

The desktop app also makes `DOZO_RELAY_AGENT_KEY` (64 hex digits) with the other secrets and
gives it to the API and to the relay agent, which signs paired phones in with it
(`dozo/relay/agent/README.md`).

The desktop app also gives the API and the worker `HOST_USER_HOME` and `HOST_USER_PATH`, the
person's own home folder and login shell `PATH` (the processes run with `HOME` in the server's
folder). With them, and only then, the server offers a provider's command-line tool the person
installed and signed in to as a model connection, run with their home and `PATH`
(`packages/adapters/src/cli-models/dozo-cli-*.ts`); `run.sh` leaves them out. More accounts of a
tool each get a home folder of their own under `data/cli-accounts/<provider>/` (mode 0700), signed in
with the tool's own sign-in; the person's own home folder of the tool is never written.

`run.sh` uses ports 54329 (Postgres), 3100 (API) and 5173 (web); the app picks free ones.

## Trimmed packages

`TRIM` in `build.mjs` lists the store folders left out, each with its reason: TypeScript and
Prettier (pulled in by the Prisma CLI, which the migrations need) and the Kubernetes client (loaded
only by that computer provider). That saves about 36 MB unpacked and under 2 MB of download.
Prisma Studio (43 MB) and Prisma's `dev` server stay: the Prisma CLI requires them as it loads, and
`migrate` fails without them. esbuild stays: pages are built with it at runtime. The smoke test is
what proves a trim safe; a name that no longer matches anything is reported in the build log.

## Backup and restore

One file holds everything the server folder needs to come back: the database (`pg_dump`, custom
format), `data/`, the secrets file (`secrets`, or `secrets.env` for `run.sh`: the encryption key
and passwords) and `relay/` (the relay agent's keys). Ports, logs and the installed versions are
left out. The file is sealed with a password; without it nothing can be read back, and nobody can
recover a lost password. Source: `packages/adapters/src/dozo-local-backup.ts` and
`dozo-local-backup-format.ts`.

```sh
node rakazo-server/dozo-local-backup.mjs create <file> --home <server folder>
node rakazo-server/dozo-local-backup.mjs restore <file> --home <server folder>
```

The password is the first line of standard input (at least 8 characters). Postgres is the bundle's
own (`../../postgres/bin` from `rakazo-server/`; `DOZO_PG_BIN` and `DOZO_SERVER_DIR` override).
One JSON line on stdout: `{"created": <path>, "server": <version>}`, `{"restored": <path>,
"server": <version>, "migrate": <bool>}` or `{"error": <sentence>, "reason": <code>}`. Exit 0 done,
2 failed, 64 usage (`reason` `usage`).

- `create` works with the app open or closed: it uses the running Postgres (its port is line 4 of
  `pgdata/postmaster.pid`) or starts one on a free loopback port and stops it after. The file is
  written next to its name as `<name>.<random>.partial`, mode 0600, and renamed when complete.
  Symbolic links and special files under `data/` and `relay/` are left out. A file that changes
  size while it is read fails the backup (`failed`); run it again. A name with a backslash fails
  it too.
- `restore` goes into a new installation only: no `pgdata/` and an empty or missing `data/`
  (`not-empty` otherwise). It opens the file into a fresh folder beside the target, refuses a
  backup whose database has a migration this server does not know (`newer`) as soon as the first
  entry is read, then makes a new cluster with the backup's owner password, creates the
  `rakazo_app` role the dump's grants name, loads the dump in one transaction, and moves
  `pgdata/`, then `data/` and `relay/`, and last the secrets file into place. A failure before
  that leaves the target as it was. A process stopped midway leaves a `backup-*` or `restore-*`
  folder (private, inside the server folder) holding plaintext; delete it. `migrate: true` means the backup is older: the next start's migration
  brings it up to date and gives `rakazo_app` its login, as every start does.
- Other reasons: `wrong-password` (or the first chunk was changed), `damaged`, `not-a-backup`,
  `no-server` (nothing to back up), `no-backup-data`, `failed` (a Postgres program failed; its
  last lines are in the sentence).

### Backup file

Built from Node's crypto (OpenSSL), nothing hand-made: scrypt for the key, AES-256-GCM to seal,
in the chunked layout of the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár 2015), so a
file of any size streams through memory.

| Bytes        | Content                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| 0–7          | `DOZOBAK\n`                                                                |
| 8            | format, `1`; a higher one is refused as from a newer Dozo                  |
| 9, 10, 11    | scrypt log2(N), r, p: written as 17, 8, 1 (128 MiB); read only 15–18, 8, 1 |
| 12–27        | salt, random per file; key = scrypt(NFC password, salt), 32 bytes          |
| 28–          | chunks: AES-256-GCM of 64 KiB of plaintext (the last 0–64 KiB), 16-byte tag |

Each chunk's nonce is the chunk number (11 bytes, big-endian) and a last-chunk byte (1 on the last
chunk, else 0); bytes 0–27 are its associated data. A reordered, dropped, changed or appended chunk,
a file cut at any point, or a changed header fails to open. The key is new for every file, so the
counter nonce never repeats under one key.

The plaintext is gzip of an archive: entries of a 4-byte big-endian length, a JSON header
(`path`, `kind` `file` or `dir`, and for a file `size` and `mode`) and the file's bytes; a zero
length ends it, and nothing may follow. The first entry is `backup.json`: `format`, `createdAt`,
`server` (the bundle version) and `migrations` (the applied migration names). Then the secrets
file, `database.dump`, `data/…` and `relay/…`. Paths are relative with plain names; restored files
keep only the owner's bits (0600, or 0700 when the owner could run it).

## Account repairs

Repairs a person makes on their own computer, against the server folder, so only whoever can reach
that folder can make them. Source: `packages/adapters/src/dozo-local-account.ts`.

```sh
node rakazo-server/dozo-local-account.mjs unlink-hosted --home <server folder>
echo '<new password>' | node rakazo-server/dozo-local-account.mjs reset-password --home <server folder>
```

- `unlink-hosted` removes every link to a hosted account, ends those users' sessions and marks
  each of them; each user keeps their data. The next hosted sign-in on that computer links a
  marked user again, whichever hosted account it is (`packages/auth/src/dozo-hosted-login.ts`);
  no other user is ever handed to a hosted account. It is the way back when the linked hosted
  account was deleted or can no longer sign in.
- `reset-password` sets a new password, because a local server sends no email and a forgotten one
  has no other way back. The new password is the first line of standard input (8 to 128
  characters). Whoever runs it must be able to read the folder's secrets file and, on Linux and
  macOS, own it (or be root). In one statement it sets the account's password hash (the sign-in
  library's scrypt format), ends every session of the account, and writes `auth.password.changed`
  to the security events and, with actor `local-reset`, to the audit log of each organization the
  account belongs to. It answers `{"reset": true, "sessionsEnded": <n>}`. Its own reasons:
  `hosted-login` (the install signs in with the hosted account, which has no password here:
  `HOSTED_LOGIN_ISSUER` is set for the command, or the account has no password sign-in),
  `no-account`, `several-accounts` (not a folder the app made) and `not-owner`. For an app
  screen: ask for the new password twice, pipe it in, show the sentence on failure; after success
  the window signs in again.

It works with the app open or closed, with the bundle's Postgres, as `backup` does (same
`DOZO_PG_BIN` and `DOZO_SERVER_DIR`). One JSON line on stdout: `{"unlinked": <n>,
"sessionsEnded": <n>}` (or the reset's answer above) or `{"error": <sentence>, "reason": <code>}`
(`usage`, `no-server`, `failed`, and the reset's own). Exit 0 done, 2 failed, 64 usage. Further repairs join this command as subcommands
with the same `--home`, output and exit codes.
