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
  was scanned. `--launch` also fails on the placeholders (every target of `urls`, such as
  `dozo.example` and `github.com/OWNER/dozo`) and on the `allow.phrases` entries not marked
  `"permanent": true` (upstream image names; a permanent one, such as an HMAC input, is never flagged).
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

Scope: `include` (globs: `apps/web`, `apps/api`, `apps/worker`, `packages`, `infra/sandboxes`) minus
`exclude`. Everything else (`apps/www`, `apps/desktop`, `apps/mobile`, `docs/`, the root files) is out
of scope: neither branded nor gated.

Keys: `from`, `to`, `variants`, `urls`, `literals`, `include`, `exclude`, `keep`, `allow`,
`leak` (extra substrings), `leakWords` (extra case-sensitive whole words, e.g. the upstream founder's
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
  `dozo/brand/assets/web/favicon.png` into the stage. The 7 web icons and `favicon.svg` are mapped
  (`favicon.svg` is linked from `apps/web/index.html` by an anchored rule).

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
that holds the old name, as the tree contains it, and masks it. Rows that are lists of names (`dotted-key`,
`css-name`, `dom-event`, `binary-name`, `service-name`, `persisted-key`, `name-prefix`, `process-marker`,
`memory-entity`, `kdf-context`) are closed: each stem is one name the tree uses, a name that continues
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
- The bot docs URLs (`dozo.example/docs/*.md`) must exist or the built-in skill has nothing to fetch.
- The welcome mail has no hero image (an anchored rule drops it) until Dozo makes one.
- Owner actions and the values to fill before launch: `dozo/LAUNCH-CHECKLIST.md`.
- Details of every audit decision: `AUDIT.md`.

## Logo

- Approved mark: H1, a soft robot head with a tilted dark visor wearing a thin red headband. Applied
  to the web icons. Artwork, files and rebuild steps: `assets/README.md`.
- Red: `#C8372D` (band only, fixed in every file except the one-ink files). Ink: `#f4f3f0` on dark,
  `#0d0d0d` on light.
- One-ink fallback: where one colour is all there is (stamp, emboss, single-colour print, forced
  colours), use `mark-mono-dark.svg` / `mark-mono-light.svg`: band in the head's ink, never red alone.
- Minimum size: full mark and lockup 32 px high; from 16 to 32 px use the reduced variant
  (`mark-small.svg`; the 16 and 32 px favicon tiles are drawn with it).
- Clear space: 1/4 of the mark's height (11 units in the lockup viewBox) on every side; the SVG viewBoxes
  are tight, so the margin is the placer's job.
- Later: the mockups show a small red seal dot beside the wordmark; the red band replaces it, so the dot is dropped.
