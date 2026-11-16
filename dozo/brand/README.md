# Dozo brand overlay

The committed tree stays "upstream Rakazo + new files under `dozo/`" so upstream merges stay
clean. The brand is applied to a throwaway staged copy right before the Docker build:

```
git archive HEAD | tar -x -C "$STAGE"
node dozo/brand/apply.mjs --root "$STAGE"     # codemod, in place
node dozo/brand/check.mjs --root "$STAGE"     # leak gate, must exit 0
```

Dependency-free Node (built-ins only). Run it in Docker, not on the host.

## CLI

All commands take `--config <file>` (default `dozo/brand/brand.json`). Failures exit 2. An unknown or
repeated option, a missing value and a stray argument exit 2 too.

- `apply.mjs --root <dir>` rewrites `<dir>` in place. Idempotent. Prints files changed,
  replacements per rule and hooks (`anchored X of N applied`, assets). Exit 2 if an anchored rule
  does not match exactly once, an asset is missing, a file is not UTF-8 or is binary in a type that
  is not a known binary, nothing is in scope, or `<dir>` has a `.git` and `--allow-git` is not given.
- `apply.mjs --root <dir> --check` same validation and summary, writes nothing (no asset either).
- `apply.mjs ... --strict` for a tree no rule has touched (a fresh stage; `make olc` and the gate on
  the committed tree): a rule that counts as already applied fails (there it can only be upstream
  drift hiding behind a short `replace`), every anchored rule must have applied, and an entry that
  matches nothing in the tree fails as dead: a `urls` key, a `variants` or `literals` entry, a
  `keep`, `allow.phrases` or `allow.text` entry, an `allow.paths` or `allow.images` glob. Delete it.
  `build.sh brand` and `make olc` pass `--strict`. Without it a re-run on a rewritten tree is a
  no-op; that lenient path is only for running `apply.mjs` by hand twice.
- `check.mjs --root <dir> [--launch]` leak gate. Exit 0 clean; exit 2 with `path:line: match` (first 50
  plus a total), and when no file was scanned. `--launch` also fails on the placeholders (the
  targets of `urls`, such as `dozo.example` and `github.com/OWNER/dozo`) and on the `allow.phrases`
  entries not marked `"permanent": true` (upstream image names; a permanent one, such as an HMAC
  input, is never flagged).
- Tests: `node --test dozo/brand/` (`index.js` makes the directory form work on Node 24).

What is guaranteed. Config, rules, assets, every file's encoding and the dead-entry check are all
validated before the first write, so a rule failure writes nothing. The write phase then replaces
each file through a temp file and a rename (the mode is kept), one file at a time; if it fails
half way (disk full, permissions) apply exits 2 with "stage is partial, re-stage", and the files
already replaced stay replaced. The stage is throwaway: re-stage, do not repair. Any other
unexpected error exits 2 as well, never with a stack trace.

## What apply does (in order, per file under `include` minus `exclude`)

1. Anchored rules (exact once; "already applied" counts as success on re-runs). They also work on
   files outside `include`, which then get no blanket rename.
2. `literals`: plain substring replace in every in-scope file, or only in the globs of `files`.
   For lowercase technical names that must change everywhere together (`/home/rakazo`).
   `urls`: longest key first, any capitalisation. A key is a whole host: no word character, dot
   or hyphen before it (`getrakazo.com` and `status.rakazo.com` are other hosts; list a subdomain
   of ours as a key of its own), and no word character, `&` or `=` after it (`rakazo.com` leaves
   `rakazo.computerOwner` alone, a store link with more query parameters is left for the gate).
3. Blanket: `\bRakazo\b` -> `Dozo`, plus `variants` (German genitive `Rakazos`). Whole-word
   matching leaves `RakazoDesktop`, `@rakazo/*`, `RAKAZO_*`, `rakazo_app` and lowercase `rakazo`.
   Phrases in `keep` are skipped, in their `files` only. `.po` and `translations-*.json` get the
   same rewrite in msgid and msgstr, matching the rewritten source strings. Assets are copied last.

Binary files (NUL byte) in a known binary type, lockfiles, `node_modules`, the `.turbo` cache and
`.git` are skipped. The staged tree is `git archive` output, so there is no build output to
exclude: a source directory named `build`, `dist` or `coverage` is branded and gated. Names of
files and directories are never renamed.

## Config (`brand.json`)

`from`, `to`, `variants`, `urls`, `literals`, `include` (globs), `exclude`, `keep` and `allow.*`
(each entry has a mandatory one-line `reason`), `leak` (extra substrings), `leakWords` (extra
case-sensitive whole words, e.g. the upstream founder's name), `anchored`, `assets`. The file is
validated when it loads: an unknown key, a wrong type, an empty `text`, `glob` or url key, a
`to`, url target, variant or literal `replace` that contains what it replaces, or a missing
`reason` or `files` exits 2 with a message.

- Add an exclusion: append `{ "glob": "path/**", "reason": "why" }` to `exclude`.
- Keep a phrase that code compares or persists: add `{ "text": "...", "files": ["path"],
  "reason": "..." }` to `keep` (apply leaves it, the gate ignores it). `keep` and `allow.phrases`
  match as a whole (not glued to a word or hyphen) and only in their `files`.
- Anchored rule: `{ "file": "apps/web/x.ts", "find": "exact text", "replace": "new",
  "reason": "why" }`. `find` must occur exactly once in the file at the time apply runs
  (`replace` occurring elsewhere does not matter). A re-run counts as already applied when `find`
  is gone and the file holds `replace`; a file with neither, or with `find` more than once, fails
  with exit 2, naming rule, file and the real count (a `\n` in `find` on a CRLF file says so).
  `replace` must be non-empty and must not contain `find`: the rule is rejected at load, because
  a re-run could not tell it applied. An optional `"requires": ["path"]` lists fork files the rule
  redirects to: apply fails ("dangling redirect") when one is missing from the tree, so a build
  never ships a dangling import. Use it for edits a regex cannot express, and later to wire visual
  hooks. Anchored rules also swap the mascot art (`packages/core/src/logo-avatar-art.ts` paths and
  eyes) and rename visible lowercase uses.
- Add an asset: `"assets": { "apps/web/public/favicon.png": "favicon.png" }` copies
  `dozo/brand/assets/web/favicon.png` into the stage. The 7 web icons and `favicon.svg` are mapped (`favicon.svg` is linked from `apps/web/index.html` by an anchored rule).

## Leak gate

Rule: **every case-insensitive occurrence of the old name in the applied tree is a leak**, unless it
sits inside one of the technical-identifier shapes in the `SHAPES` table (`lib.mjs`, one row per
shape with its reason: `@rakazo/*` scope, `RAKAZO_*` names, `x-rakazo-*` headers, `rakazo_*`
snake names, `RakazoDesktop`-style identifiers, `rakazo.key` and `rakazo:key` keys, CSS classes,
computer-image binaries and paths, service names, key-derivation contexts, ...) or a reviewed
phrase. The shapes are finite on purpose: `rakazo-powered`, `#rakazo`, `rakazo.`, `- Ask rakazo`
and `You are rakazo, ${x}` are leaks wherever they stand. A new upstream identifier that is
really technical fails the gate once; add its shape (narrowly, with a reason and a positive and
a negative sample in `brand.test.mjs`), never loosen a row.

Reviewed text, all with a reason, all scoped, none per file as a whole:

- `keep` and `allow.phrases`: `{text, files}`, matched as a whole phrase in those files only.
- `allow.text`: `{file, text}`, one file, one text (the persisted enum values, vendor headers,
  `"rakazo"` client names that are not shown). The rest of the file is still checked.
- `allow.paths`: globs of file and directory names that carry the old name on purpose.
- `allow.images`: images that are reviewed but not mapped.

Also checked:

- `urls` keys, every `leak` substring (`rakazo.com`, `elie222/rakazo`, and the bare ids of the store
  and Discord links, which catch their other forms) and the old name with any public TLD
  (`rakazo.ai`, `.app`, `.io`, `hello@rakazo.ai`), case-insensitive. The new name followed by a
  public TLD (`Dozo.com`) unless a `urls` target owns it.
- a PascalCase brand identifier standing between plain words (`Ask RakazoBot to help`), and a
  string that is exactly one such name (`"RakazoIntrospection"`, a client or operation name).
- a URL target glued to a word (`dozo.exampleputerOwner`): a rewrite ate part of another token.
- `literals`: a `find` still present means the rule did not run.
- file and directory names with the old name, once per path, unless in `allow.paths`.
- images: every image in scope (any type in `BINARY_EXT`) must be in `assets` or reviewed in
  `allow.images`; an `.svg` is scanned as text as well; a mapped asset must equal our file byte for
  byte. A NUL byte in a file that is not a known binary type (UTF-16 text) is reported.
- symlinks whose target is outside the tree or cannot be resolved.
- a tree with no file in scope fails.

Findings are de-duplicated (a finding inside the span of an earlier, longer one is the same leak).

Still not caught: images that were reviewed in `allow.images`; text generated at runtime; text
assembled from fragments (`"rak" + "azo"`, `` `${name}` ``); an identifier-shaped token that is really
prose (`rakazo.something` after a space, `RakazoBot` standing alone); `rakazo.<tld>` with a TLD
that is not in the list; any other Discord invite code or social host (the bare id of the known
invite is checked); build output, `.map` files and files outside `include`.

## Values to fill before launch

- `dozo.example` (and `app.`, `www.` subdomains): the product domain; docs, privacy, plugin pages,
  `/api/download`, email images all point there.
- `github.com/OWNER/dozo`: the fork repository (self-update, star prompt, releases, user agent).
- `https://dozo.example/discord`, `/get/ios`, `/get/android`: Discord invite and store links.
- `ghcr.io/elie222/rakazo/computer` and `PUBLISHED_IMAGE_REPO`: still pull upstream images
  (allow-listed in the gate); switch when Dozo publishes its own.

## Known gaps

- Lowercase and technical names stay Rakazo by design: `Rakazo.icon`, headers, cookies, storage
  keys, `rakazo://`, binary names in the computer image (`rakazo-browser`), `/tmp/rakazo`,
  `~/rakazo-home`, vendor-facing `originator` values. The bot computer user and home are `dozo`
  (anchored rules plus the `/home/rakazo` literal); the image must be rebuilt for it.
- The stored prefix `Rakazo-owned compacted context` is only accepted when reading; new
  summaries say `Dozo-owned`.
- Details of every audit decision: `AUDIT.md`.
- Out of scope: `apps/www`, `apps/desktop`, `apps/mobile`, `docs/`, root README files.
- Tests, `apps/web/e2e` and `packages/testkit` are not rewritten; run them on the pristine tree.
- The bot docs URLs (`dozo.example/docs/*.md`) must exist or the built-in skill has nothing to fetch.
- The welcome mail has no hero image (the anchored rule drops it) until Dozo makes one.

## Logo

- Approved mark: H1, a soft robot head with a tilted dark visor wearing a thin red headband. Artwork,
  files and rebuild steps: `assets/README.md`.
- Red: `#C8372D` (band only, fixed in every file). Ink: `#f4f3f0` on dark, `#0d0d0d` on light.
- One-ink fallback: where one colour is all there is (stamp, emboss, single-colour print, forced
  colours), use `mark-mono-dark.svg` / `mark-mono-light.svg`: band in the head's ink, never red alone.
- Minimum size: full mark and lockup 32 px high; below that use `mark-small.svg` (16-31 px).
- Clear space: 1/4 of the mark's height (11 units in the lockup viewBox) on every side; the SVG viewBoxes
  are tight, so the margin is the placer's job.
- Later: the mockups show a small red seal dot beside the wordmark; the red band replaces it, so the dot is dropped.
