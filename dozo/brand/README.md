# Dozo brand overlay

The committed tree stays "upstream Rakazo + new files under `dozo/`" so upstream merges stay
clean. The brand is applied to a throwaway staged copy right before the Docker build. This is the
one home for how the codemod, the config and the leak gate work, and for which identifiers are kept
or renamed. What `build.sh` and the gates run around it: `dozo/docker/README.md`.

```
git archive HEAD | tar -x -C "$STAGE"
node dozo/brand/apply.mjs --root "$STAGE" --strict   # codemod, in place
node dozo/brand/check.mjs --root "$STAGE"            # leak gate, must exit 0
```

Dependency-free Node (built-ins only). Run it in Docker (`node:24.22-slim`), not on the host; that is what
`build.sh brand` does.

## CLI

All commands take `--config <file>` (default `dozo/brand/brand.json`). Failures exit 2. An unknown or
repeated option, a missing value and a stray argument exit 2 too, as does any unexpected error (never
a stack trace).

- `apply.mjs --root <dir>` rewrites `<dir>` in place. Prints `files scanned`, `changed`, the
  replacements per rule, and `hooks: anchored X of N applied, A already applied; assets K copied`
  (`X` anchored rules applied by this run out of the `N` in the config). Exit 2 when an anchored rule
  does not match exactly once or targets a symlink or a binary, a `requires` file is missing from the
  tree, an asset is missing or its source is outside `assets/`, a file is not valid UTF-8, a file has a NUL byte but is not a known
  binary type, nothing is in scope, or `<dir>` has a `.git` and `--allow-git` is not given.
- `apply.mjs --root <dir> --check` runs the same validation and prints the same summary ("would
  change"), and writes nothing, assets included.
- `apply.mjs ... --strict` is for a tree no rule has touched (a fresh stage; `make olc` on the working
  tree, git-ignored files included). A rule that counts as already applied fails there: it can only be upstream drift hiding
  behind a short `replace`. Every anchored rule must have applied, and an entry that matches nothing
  in the tree fails as dead: a `urls` key, a `variants` or `literals` entry, a `keep`, `allow.phrases`
  or `allow.text` entry, an `allow.paths` name or `allow.binary` glob, and, with the shipped config, a
  `SHAPES` row or stem (see Leak gate). An `allow.text` entry also fails when its file holds more or
  fewer occurrences than its `count`. Delete or fix it. `build.sh brand` and `make olc` pass `--strict`. Without it a re-run on a rewritten tree is a no-op (idempotent); that
  lenient path is only for running `apply.mjs` by hand twice.
- `check.mjs --root <dir> [--launch]` is the leak gate. Exit 0 prints `leak gate clean: N files
  scanned`. Exit 2 prints `path:line: match` (the first 50, then a total) and also fails when no file
  was scanned. `--launch` also fails on the `allow.phrases` entries not marked `"permanent": true`
  (upstream image names; a permanent one, such as an HMAC input, is never flagged).
  No gate passes `--launch`: it is run by hand before launch (`dozo/LAUNCH-CHECKLIST.md`).
- Tests: `node --test "dozo/brand/*.test.mjs"`: one file per topic (`brand.apply`, `brand.gate`, `brand.config`), so
  Node runs them in parallel; the shared fixtures are in `brand.test-support.mjs`.

What is guaranteed. Config, rules, assets, the encoding of every file read and the dead-entry check
are all validated before the first write, so a rule failure writes nothing. The write phase then
writes the assets and replaces each rewritten file through a temp file
(`<name>.dozo-tmp-<pid>`) and a rename, keeping the mode, one file at a time. If it fails half way (disk
full, permissions) apply exits 2 with "the stage is partial, re-stage it" and the files already
replaced stay replaced. A write that fails removes its own temp file; one that is killed outright can
leave it behind, and the gate would then scan it as content. The stage is throwaway: re-stage, do not
repair.

Encoding: a file in scope that is not valid UTF-8 stops apply and check (exit 2, naming the file;
convert it or exclude it with a reason), so a rewrite never corrupts it. A file of a known binary type
(`BINARY_EXT` in `lib.mjs`: images, fonts, media, pdf) is never decoded, whatever its bytes: apply skips
it and the gate handles it (see Leak gate). Only `.svg` is also text, so an `.svg` must be valid UTF-8.
A NUL byte in any other type (UTF-16 text) is an error in apply and a finding in the gate.

## What apply does (in order, per file under `include` minus `exclude`)

1. Anchored rules (`find` exactly once; a file that already holds `replace` counts as applied on a
   re-run without `--strict`). They also work on files outside `include`, which then get no blanket
   rename.
2. `literals`: plain substring replace in every in-scope file, or only in the globs of `files`.
   For lowercase technical names that must change everywhere together (`/home/rakazo`).
   `urls`: longest key first, any capitalisation, the target written exactly. A key is a whole host:
   no word character, dot or hyphen before it (`getrakazo.com` and `status.rakazo.com` are other
   hosts; list a subdomain of ours as a key of its own), and no word character, `&` or `=` after it
   (`rakazo.com` leaves `rakazo.computerOwner` alone, a store link with more query parameters is not
   the key and is left for the gate).
3. Blanket: `\bRakazo\b` -> `Dozo`, plus `variants` (German genitive `Rakazos`). Whole-word
   matching leaves `RakazoDesktop`, `@rakazo/*`, `RAKAZO_*`, `rakazo_app` and lowercase `rakazo`.
   Phrases in `keep` are skipped, in their `files` only. The `.po` catalogs and `translations-*.json`
   under `include` are ordinary text and get the same rewrite.
4. Assets (`assets`) are written before the rewritten files.

Never read or rewritten: `.git`, `node_modules`, `data/` at the top of the tree (the stack's app
data) and `dozo/.stage`. Files matching `exclude` get no rewrite. The staged tree is `git archive`
output, so there is no build output to exclude: a source directory named `build`, `dist` or `coverage`
is branded and gated. Names of files and directories are never renamed.

## Config (`brand.json`)

Scope: `include` (globs: `apps/web`, `apps/api`, `apps/worker`, `packages`, `infra/sandboxes`, `apps/mobile`,
plus the image files of `apps/desktop`) minus `exclude`. A glob may use `{a,b}` (one level) for
alternatives; the image glob lists the extensions of `BINARY_EXT` that are pictures. Everything else
(`apps/www`, the text, bundle ids and store entries of `apps/desktop`, `docs/`, the root
files) is out of scope: neither branded nor gated. So an upstream picture added under desktop
fails the gate until it is mapped or reviewed, while its source text stays phase 3.

The mobile app is in scope as the iOS build ships it (`dozo/mobile/`): screens, permission texts, the
widget, the Siri intents and the iOS side of the local native modules. Out, each an `exclude` entry: its
tests and device flows, upstream's store screenshot tooling, the sound files, and the Android sources of
the native modules (no Android build is made, so an Android build of the staged tree would still show
upstream's name in its notification channels).

Keys: `from`, `to`, `variants`, `urls`, `literals`, `include`, `exclude`, `keep`, `allow`,
`leak` (extra substrings), `placeholders` (see below), `leakWords` (extra case-sensitive whole words, e.g. the upstream founder's
first name), `anchored`, `assets`. Every entry of `exclude`, `keep`, `allow.*`, `literals` and
`anchored` has a mandatory one-line `reason`. The file is validated when it loads and exits 2 on: an
unknown key, a wrong type, an empty `text`, `glob`, `file` or url key, a missing or empty `reason`, a
missing or empty `files` list where one is required (`keep`, `allow.phrases`), a wildcard (`*`, `?`) in
`allow.paths` (it lists exact names), an `allow.text` `count` that is not a whole number of 1 or more,
the old key `allow.images` (renamed `allow.binary`), an empty `include`, a
`to`, url target, variant or literal `replace` that contains what it replaces, or an anchored rule with
an empty `replace` or one that contains its `find`.

- Add an exclusion: append `{ "glob": "path/**", "reason": "why" }` to `exclude`. The entries and
  their reasons are in `brand.json`: dependencies and caches, lockfiles, licence, notice and changelog
  files, tests, specs and snapshots (they run on the pristine tree and assert on upstream strings),
  `apps/web/e2e`, `packages/testkit`, two offline emulator files in `packages/adapters`, and the
  Prisma schema and migrations (checksummed and persisted).
- Keep a phrase that code compares or persists: add `{ "text": "...", "files": ["path"],
  "reason": "..." }` to `keep` (apply leaves it, the gate ignores it). `keep` and `allow.phrases`
  match as a whole (not glued to a word or hyphen) and only in their `files`.
- Anchored rule: `{ "file": "apps/web/x.ts", "find": "exact text", "replace": "new",
  "reason": "why" }`. `find` must occur exactly once in the file at the time apply runs
  (`replace` occurring elsewhere does not matter); otherwise apply exits 2, naming rule, file and the
  real count (a `\n` in `find` on a CRLF file says so). An optional `"requires": ["path"]` lists fork
  files the rule redirects to: apply fails ("dangling redirect") when one is missing from the tree,
  so a build never ships a dangling import. Use it for edits a regex cannot express, and for
  redirects to `dozo-*` wrappers.
- Add an asset: `"assets": { "apps/web/public/favicon.png": "web/favicon.png" }` copies
  `dozo/brand/assets/web/favicon.png` into the stage. The 7 web icons, `favicon.svg`, the desktop and
  mobile icon, splash and widget images and the Icon Composer layer are mapped
  (`favicon.svg` is linked from `apps/web/index.html` by an anchored rule; the table is in
  `assets/README.md`). One source may feed several targets (the mobile favicon is the web one).

## Identifiers

Kept (never renamed): a technical identifier that code, stored data or tooling refers to. The finite
list is the `SHAPES` table in `lib.mjs`, one row per shape with its reason: the `@rakazo/*` scope,
`RAKAZO_*` names, `x-rakazo-*` headers, `data-rakazo-*` attributes, `rakazo_*` and camelCase names
(`RakazoDesktop`), `rakazo.key` and `rakazo:key` keys (and the `rakazo://` scheme), CSS names of the
avatars, computer-image executables and paths (`rakazo-browser`, `/tmp/rakazo`, `~/rakazo-home`),
service and package names, persisted keys and key-derivation contexts, the `rakazo/computer` image
name, and so on. Also kept: the `Rakazo.icon` directory, vendor-facing client names, cookies and storage
keys. Do not rename one by hand. If upstream adds a real identifier, add a shape row (below).

Renamed on purpose (each is a rule in `brand.json`):

- Bot computer user and home directory: `/home/rakazo` -> `/home/dozo` (literal), plus the
  `useradd`/`USER` anchored rules and `rakazo-runtime` -> `dozo-runtime` for arbitrary uids.
- Shared workspace and peer ids: `rakazo-shared` -> `dozo-shared` (literal) and the default memory
  workspace id `rakazo-<space>` -> `dozo-<space>` (anchored rules in the Honcho provider and settings).
- Compaction prefix: `Rakazo-owned compacted context` -> `Dozo-owned compacted context` in new
  summaries; the reader still accepts the old prefix (`keep`).
- The memory-provider provenance label `rakazo space:<id> bot:<id>` -> `dozo space:<id> bot:<id>`
  (free text sent to the provider; nothing reads it back; the entity ids `rakazo-space/...` stay).
- The mobile app's id family: `com.rakazo.app` -> `dev.ssilistre.dozo`, one literal limited to
  `apps/mobile/app.json` and `lib/incoming-share.ts`. The iOS bundle id, the widget, share and
  notification extensions (`<id>.widgets`, `<id>.expo-sharing-extension`, `<id>.notifications`), the app
  group (`group.<id>`) and the Android package all carry that prefix, so it is defined once. Three
  anchored rules in `app.json` set the Expo slug and drop upstream's Expo owner, EAS project id and
  update URL (updates are off).

Kept in the mobile app, each a stem or a reviewed text: the `rakazo://` deep-link scheme (the API trusts
it as the app's origin and writes it into notification links, so it can only change together with the
server; an upstream app on the same phone claims the same scheme), the secure-store and defaults keys
(`rakazo.session_token`), the names of the local native modules (`RakazoNotifications`,
`modules/rakazo-notifications`), Swift type and file names, and the Xcode widget target `RakazoWidgets`.
None is shown. The server side still names upstream's bundle id (`app-association.ts`,
`apns-voip-config.ts`, reviewed in `allow.text`): push and passkeys for a Dozo app need those changed
with the owner's ids (`dozo/LAUNCH-CHECKLIST.md`).

This is consistent for a fresh Dozo installation built entirely from the staged tree. It is not
compatible with data or volumes created by an upstream Rakazo installation (home directories, memory
workspaces and peers), nor with the prebuilt upstream computer image
`ghcr.io/elie222/rakazo/computer`, which still uses `/home/rakazo`. Dozo must always run its own
computer image built from the staged tree; rebuild it after changing these rules.

## Leak gate

Rule: **every case-insensitive occurrence of the old name in the applied tree is a leak**, unless it
sits inside one of the technical-identifier shapes in `SHAPES` (`lib.mjs`) or a reviewed text. Only the
shape table lets an identifier through: it is finite on purpose, so `rakazo-powered`, `#rakazo`,
`rakazo.`, `- Ask rakazo` and `You are rakazo, ${x}` are leaks wherever they stand. Each row is
`{ name, re, reason }`: a case-sensitive (except `header`) global regex that matches the whole token
that holds the old name, as the tree contains it, and masks it. A path row ends where the tree's names end: `fs-path` takes the bare directory (`/tmp/rakazo`) only
before `/`, a quote, a space, punctuation, a full stop no word follows or the line end (`/etc/rakazo.conf` is a leak), and `policy-path` is the one
file named `rakazo.json`. Rows that are lists of names (`dotted-key`,
`css-name`, `dom-event`, `binary-name`, `service-name`, `persisted-key`, `name-prefix`, `process-marker`,
`memory-entity`, `kdf-context`, `fs-path`, `shell-path`) are closed: each stem is one name the tree uses, a name that continues
with a letter, digit, `_` or `-` is another name, and `apply --strict` (with the shipped config) fails on a
row or a stem that matches nothing in the tree. Some rows also look at the neighbourhood:

- `camel-name` (`RakazoDesktop`, `rakazoScreen`, `isRakazoContainer`) is code only after `.`, after
  `new class type interface function const let var typeof`, after `<` (a JSX tag or type argument),
  alone in a string, before `(` or `.name`, or in a slot (object key, parameter, type annotation, import
  list) that follows no word and is followed by `: = ? | & , ; ) ] } >`. Between plain words
  (`Welcome to RakazoAI Pro`), in JSX text (`<b>RakazoPro</b>`) and in a string with spaces it is a leak.
- `dotted-key` (`rakazo.botId`) needs quotes, a URL or path before it, or `=` after it.
- The hyphen rows are prose, hence a leak, between a plain word and a lowercase word
  (`Try the rakazo-browser app`).

Known limit of the open prefix rows (`snake-name`, `env-name`, `data-attribute`, `package-scope`,
`header`): they match the prefix alone (`rakazo_`, `RAKAZO_`, `data-rakazo-`, `@rakazo/`,
`x-rakazo-`), wherever it stands, so the same text in plain prose also passes. Only the closed rows
check what follows the name.

A free part inside a row's token (a directory in `fs-path`, the variable in `shell-path`, the host in
`dev-database`) may not carry the name in any capitalisation: only the directory `rakazo` itself may stand
in the middle of a path. The closed rows of file and binary names end at `[\w-]`, so a file extension after
a stem (`rakazo-proxy.json`, `rakazo-browser.desktop`, `librakazo-xcapture.so`) passes, because the tree
uses them; `rakazo-api.bak` therefore passes too. `policy-path` is the one file row that refuses an extension.

Limits of the neighbourhood: a parenthesised or colon-ended name (`(RakazoPro)`, `RakazoBot: hi`) reads
as a slot; a hyphen name at the start of a line or before `-`, `.` or a quote is not prose; a class
list is prose-like (`ring rakazo-bot-avatar-ring-working absolute` is one reviewed `allow.text`). The
gate cannot tell these from code without parsing, so a new one is reviewed, not guessed. To add a row or
stem when a new upstream identifier is really technical and fails the gate: add it narrowly with its
reason, with a positive and a negative sample in `brand.gate.test.mjs`; never loosen an existing row.

Reviewed text, each with a `reason`, each scoped, matched as a whole phrase:

- `keep` and `allow.phrases`: `{text, files}` (`files` required), in those files only.
  `allow.phrases` may carry `"permanent": true` (see `--launch`).
- `allow.text`: `{file, text, count}`, one file, one text (persisted enum values, vendor headers,
  `"rakazo"` client names that are not shown, a code name that sits in a sentence). The rest of the
  file is still checked. `count` (default 1) is how many occurrences the entry stands for: the gate
  fails on more (a new occurrence is a new leak) and on fewer.
- `allow.paths`: the exact names of files and directories that carry the old name on purpose. A glob is
  a config error: a wildcard would pass any future file.
- `allow.binary`: files of a binary type (images, fonts, media, pdf) that are reviewed but not mapped.

Also checked:

- `urls` keys, every `leak` substring (`rakazo.com`, `elie222/rakazo`, `elie222`, `com.rakazo.app`, and
  the bare Discord invite code and App Store id, which catch their other forms) and the old name with
  a public TLD from a fixed list (`TLDS` in `lib.mjs`: `rakazo.ai`, `.app`, `.io`, `hello@rakazo.ai`),
  case-insensitive. The new name followed by one of those TLDs (`Dozo.com`), unless a `urls` target
  owns it. Any other `rakazo.<word>` that is not a listed dotted key (`rakazo.fun`) is a leak too.
- a string that is exactly one PascalCase brand name (`"RakazoIntrospection"`, a client or operation
  name); a PascalCase name between plain words (`Ask RakazoBot to help`) is a leak by the `camel-name` rule.
- a URL target glued to a word (`dozo.exampleputerOwner`): a rewrite ate part of another token.
- `literals`: a `find` still present means the rule did not run.
- file and directory names with the old name, once per path, unless in `allow.paths`.
- binary types (`BINARY_EXT`: images, fonts, media, pdf): each must be in `assets` or reviewed in
  `allow.binary` ("binary file neither mapped nor reviewed"); an `.svg` is also scanned as text; a
  mapped asset must equal our file byte for byte and must exist in the tree.
- an `allow.text` entry whose file holds more or fewer occurrences than its `count`.
- a NUL byte in a file that is not a known binary type (UTF-16 text) is reported, not skipped.
- symlinks whose target is outside the tree or cannot be resolved.
- a tree with no file in scope fails.

Findings are de-duplicated (a finding inside the span of an earlier, longer one is the same leak).

Still not caught: binary files reviewed in `allow.binary`; text generated at runtime; text assembled
from fragments (`"rak" + "azo"`, `` `${name}` ``); an identifier-shaped token that is really prose
within the limits of the neighbourhood rules above; any other Discord invite code or social host; build
output, `.map` files and files outside `include`. A stem that occurs only inside a reviewed `keep` or
`allow.text` phrase still counts as alive for the dead-stem check.

## Known gaps

- Tests, `apps/web/e2e` and `packages/testkit` are not rewritten; run them on the pristine tree.
- Dozo has no docs site, plugin submission page, public integration pages, store listing, Android
  build or community server, so anchored rules drop what linked to them: the bot's product-docs skill
  and its fetch list, the error help link, "Submit a plugin" (web and mobile), "Get the mobile app",
  the GitHub star prompt, and the welcome mail's store, Linux, Discord and GitHub-star links and its
  hero image. A claimed integration and its confirmation link open the app's integrations view; the
  in-app store fallback opens the landing page (it has no download anchor to point at). An expired
  claim link gets the API's existing "already used or invalid" answer. The welcome mail links only
  the desktop release files the landing page links. `assets/mail/welcome.png` is kept as artwork but
  no longer mapped.
- Self-update: no repository counts as official (anchored rule in `packages/core/src/self-update.ts`,
  held by `dozo-self-update.test.ts`), so an update builds the deployment's checkout and never pulls
  upstream's image. Undo the rule once Dozo publishes its own images under its name.
- `placeholders` (`dozo.example`, `OWNER/`): an address that does not exist. Any left in a branded
  file fails `apply` (so `make olc` and every stage) and the leak gate, naming file and line. Point a
  new upstream link at a real address with an anchored rule, or drop it.
- Desktop: only its pictures are branded. Packaging text, bundle ids, store listings and the
  `.icns` build are untouched. `Rakazo.icon/icon.json` keeps `system-dark` as the plate and is moved
  from 90 points low to centred by an anchored rule; the iOS build compiles it into the app icon.
- Mobile: the store fallback opens the landing page, and the paywall's terms link the landing site's
  terms; no Android build is made. What a Dozo iOS build has switched off:
  `dozo/mobile/README.md`.
- Owner actions and the values to fill before launch: `dozo/LAUNCH-CHECKLIST.md`.
- Details of every audit decision: `AUDIT.md`.

## Logo

- Approved mark: H1, a soft robot head with a tilted dark visor wearing a thin red headband. Applied
  to the web icons, the desktop (Electron) and mobile (Expo) icons, splash and widget image, and the
  welcome-mail hero. Artwork, files and rebuild steps: `assets/README.md`.
- Red: `#C8372D` (band only, fixed in every file except the one-ink files). Ink: `#f4f3f0` on dark,
  `#0d0d0d` on light.
- One-ink fallback: where one colour is all there is (stamp, emboss, single-colour print, forced
  colours), use `mark-mono-dark.svg` / `mark-mono-light.svg`: band in the head's ink, never red alone.
- Minimum size: full mark and lockup 32 px high; from 16 to 32 px use the reduced variant
  (`mark-small.svg`; the 16 and 32 px favicon tiles are drawn with it).
- Clear space: 1/4 of the mark's height (11 units in the lockup viewBox) on every side; the SVG viewBoxes
  are tight, so the margin is the placer's job.
- Later: the mockups show a small red seal dot beside the wordmark; the red band replaces it, so the dot is dropped.

## E-mail shell

- Every account and product mail (`packages/auth/src/*email*.tsx`) is drawn by one fork file,
  `packages/auth/src/dozo-email-shell.tsx`, which anchored rules in `email.tsx` point at: the Dozo
  palette as solid hex (light by default, dark where the client honours `prefers-color-scheme`), the
  theme's font stack, the header (mark and lowercase wordmark) and the footer (unsubscribe when the
  mail has one, privacy and terms on the landing site in English or Turkish, operator and contact).
- The mark travels inside the mail as an inline image (`DOZO_MARK`, referenced as `cid:dozo-mark`),
  so it shows where remote images are blocked and no mail loads anything from a server: no remote
  image, no tracking pixel. Transactional mail carries it in an optional `inline` field that both
  email adapters translate (anchored rules on `adapter-kit/src/types.ts`, `smtp-email.ts`,
  `resend-email.ts`; tested by `packages/adapters/src/dozo-email-inline.test.ts`). The welcome mail
  keeps its hero image instead of the header.
- A verification link lands on the web app's result page (`/verify-email`, set by
  `packages/auth/src/dozo-email-link.ts`): verified, expired with a new link, or not valid.
- The sender's name is not in the code: it is the name part of `EMAIL_FROM` (for example
  `Dozo <no-reply@your-domain>`), set where the server runs.
- Upstream's `email.test.ts` asserts that code mails carry no link; on the branded tree they carry
  the footer's links. Its tests run on the pristine tree only, like the rest.
- Turkish mails address the reader as "siz"; the referral and file deletion mails are aligned by
  rules on `locales/tr.ts`. Mails in other languages show the footer in English.
