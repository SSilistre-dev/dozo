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

All commands take `--config <file>` (default `dozo/brand/brand.json`). Failures exit 2.

- `apply.mjs --root <dir>` rewrites `<dir>` in place. Idempotent. Prints files changed,
  replacements per rule and hooks (anchored rules, assets). Exit 2 if an anchored rule does not
  match exactly once, an asset is missing, or `<dir>` has a `.git` and `--allow-git` is not given.
  On failure nothing is written.
- `apply.mjs --root <dir> --check` same validation and summary, writes nothing.
- `check.mjs --root <dir> [--launch]` leak gate; `--launch` also fails on placeholders
  (`dozo.example`, `OWNER/dozo`) and the allow-listed upstream image names. Exit 0 clean; exit 2 with `path:line: match` (first 50 plus
  a total).
- Tests: `node --test dozo/brand/` (`index.js` makes the directory form work on Node 24).

## What apply does (in order, per file under `include` minus `exclude`)

1. Anchored rules (exact once; "already applied" counts as success on re-runs).
2. `literals`: plain substring replace in every in-scope file, or only in the globs of `files`.
   For lowercase technical names that must change everywhere together (`/home/rakazo`).
   `urls`: longest key first, and a key does not match when a word character follows
   (`rakazo.com` leaves `rakazo.computerOwner` alone).
3. Blanket: `\bRakazo\b` -> `Dozo`, plus `variants` (German genitive `Rakazos`). Whole-word
   matching leaves `RakazoDesktop`, `@rakazo/*`, `RAKAZO_*`, `rakazo_app` and lowercase `rakazo`.
   Phrases in `keep` are skipped. `.po` and `translations-*.json` get the same rewrite in msgid and
   msgstr, matching the rewritten source strings. Assets are copied last.

Binary files (NUL byte), lockfiles, `node_modules`, build output and `.git` are skipped.

## Config (`brand.json`)

`from`, `to`, `variants`, `urls`, `literals`, `include` (globs), `exclude`, `keep` and `allow.*`
(each entry has a mandatory one-line `reason`), `leak` (extra substrings), `leakWords` (extra
case-sensitive whole words, e.g. the upstream founder's name), `anchored`, `assets`.

- Add an exclusion: append `{ "glob": "path/**", "reason": "why" }` to `exclude`.
- Keep a phrase that code compares or persists: add `{ "text": "...", "reason": "..." }` to `keep`
  (apply leaves it, the gate ignores it).
- Add an anchored rule: `{ "file": "apps/web/x.ts", "find": "exact text", "replace": "new",
  "reason": "why" }`. `find` must occur exactly once in the file at the time apply runs. A re-run
  counts as already applied when the file holds `replace` and no un-replaced `find` (so `replace`
  may contain `find`); a file with neither fails with exit 2, naming rule and file. An optional
  `"requires": ["path"]` lists fork files the rule redirects to: apply fails ("dangling redirect")
  when one is missing from the tree, so a build never ships a dangling import. Use it for
  edits a regex cannot express, and later to wire visual hooks. Anchored rules also swap
  the mascot art (`packages/core/src/logo-avatar-art.ts` paths and eyes) and rename visible
  lowercase uses. An anchored rule works on files outside `include`.
- Add an asset: `"assets": { "apps/web/public/favicon.png": "favicon.png" }` copies
  `dozo/brand/assets/web/favicon.png` into the stage. The 7 web icons are mapped.

## Leak gate

In the same file set as apply, it flags `\bRakazo\b` (and variants), every `urls` key and every
`leak` substring (`rakazo.com`, `elie222/rakazo`, case-insensitive). It ignores `keep` and
`allow.phrases` text and `allow.files` globs. Strict by default: an unknown occurrence fails, which
catches new upstream strings after each sync. Fix by extending the rules, never by loosening the gate.

Also checked, beyond the old name (patterns in `VISIBLE_PATTERNS`, `lib.mjs`):

- all-caps `RAKAZO` as a standalone word anywhere (`RAKAZO_*` and `__RAKAZO_X__` are identifiers
  and pass).
- lowercase `rakazo` standing alone (not glued to `_ . : - / @ $ { = \`) in: `alt`, `aria-label`,
  `title`, `placeholder`, `label`, `tooltip` values; text between tags on one line; a string or
  template literal that contains spaces; a line of plain words (JSX text, multi-line prompts);
  a bare text node, a quoted exact `"rakazo"` / `"RakazoXyz"`, a download file name
  (`rakazo-...zip`), a `.po` entry (headers excluded), a visible `@rakazo` handle. Comments are
  ignored. Reviewed technical uses are listed per file in `allow.lowercase` or by phrase in
  `allow.phrases` (with a reason); `allow.lowercase` does not cover all-caps or links.
- social profile links `<host>/rakazo...` on x.com, twitter.com, github.com, facebook.com,
  instagram.com, t.me, tiktok, threads, bsky, linkedin (company/in/showcase), youtube
  (`@`, c, user, channel), medium, reddit, discord.gg and discord.com/invite, any case.
  `urls` keys (store links, the known Discord invite) are matched separately.
- a URL target glued to a word (`dozo.exampleputerOwner`): a rewrite ate part of another token.
- `literals`: a `find` still present means the rule did not run.
- images: every image in scope must be in `assets` or reviewed in `allow.images`; a mapped asset
  must equal our file byte for byte.

Still not caught: images without a mapping that were already reviewed in `allow.images`; text
generated at runtime; text assembled from fragments (`"rak" + "azo"`, `` `${name}` ``); a
single bare word in a string (`"rakazo"` only via the exact-quote check, never inside identifiers);
any other Discord invite code or social host not in the list; build output, `.map` files and
files outside `include`.

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
