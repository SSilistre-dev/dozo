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
- `check.mjs --root <dir>` leak gate. Exit 0 clean; exit 2 with `path:line: match` (first 50 plus
  a total).
- Tests: `node --test dozo/brand/` (`index.js` makes the directory form work on Node 24).

## What apply does (in order, per file under `include` minus `exclude`)

1. Anchored rules (exact once; "already applied" counts as success on re-runs).
2. `urls`: plain substring replace, longest key first.
3. Blanket: `\bRakazo\b` -> `Dozo`, plus `variants` (German genitive `Rakazos`). Whole-word
   matching leaves `RakazoDesktop`, `@rakazo/*`, `RAKAZO_*`, `rakazo_app` and lowercase `rakazo`.
   Phrases in `keep` are skipped. `.po` and `translations-*.json` get the same rewrite in msgid and
   msgstr, matching the rewritten source strings. Assets are copied last.

Binary files (NUL byte), lockfiles, `node_modules`, build output and `.git` are skipped.

## Config (`brand.json`)

`from`, `to`, `variants`, `urls`, `include` (globs), `exclude` and `keep` and `allow.*` (each
entry has a mandatory one-line `reason`), `leak` (extra substrings), `anchored`, `assets`.

- Add an exclusion: append `{ "glob": "path/**", "reason": "why" }` to `exclude`.
- Keep a phrase that code compares or persists: add `{ "text": "...", "reason": "..." }` to `keep`
  (apply leaves it, the gate ignores it).
- Add an anchored rule: `{ "file": "apps/web/x.ts", "find": "exact text", "replace": "new",
  "reason": "why" }`. `find` must occur exactly once in the file at the time apply runs. Use it for
  edits a regex cannot express, and later to wire visual hooks. `anchored` ships empty: every
  must-change identifier is covered by the blanket rule and the URL map.
- Add an asset: `"assets": { "apps/web/public/favicon.png": "favicon.png" }` copies
  `dozo/brand/assets/favicon.png` into the stage. Ships empty (logo not final).

## Leak gate

In the same file set as apply, it flags `\bRakazo\b` (and variants), every `urls` key and every
`leak` substring (`rakazo.com`, `elie222/rakazo`, case-insensitive). It ignores `keep` and
`allow.phrases` text and `allow.files` globs. Strict by default: an unknown occurrence fails, which
catches new upstream strings after each sync. Fix by extending the rules, never by loosening the gate.

## Values to fill before launch

- `dozo.example` (and `app.`, `www.` subdomains): the product domain; docs, privacy, plugin pages,
  `/api/download`, email images all point there.
- `github.com/OWNER/dozo`: the fork repository (self-update, star prompt, releases, user agent).
- `https://dozo.example/discord`, `/get/ios`, `/get/android`: Discord invite and store links.
- `ghcr.io/elie222/rakazo/computer` and `PUBLISHED_IMAGE_REPO`: still pull upstream images
  (allow-listed in the gate); switch when Dozo publishes its own.

## Known gaps

- Lowercase and technical names stay Rakazo by design: `/home/rakazo`, the `rakazo` Linux user
  and shell prompt in bot computers, `Rakazo.icon`, headers, cookies, storage keys, `rakazo://`.
- The persisted prefix `Rakazo-owned compacted context` stays and can show up in model context.
- Out of scope: `apps/www`, `apps/desktop`, `apps/mobile`, `docs/`, root README files.
- Tests, `apps/web/e2e` and `packages/testkit` are not rewritten; run them on the pristine tree.
- The bot docs URLs (`dozo.example/docs/*.md`) must exist or the built-in skill has nothing to fetch.
- Logo, favicon, PWA icons and `Wordmark` art are not replaced (assets map is empty).
