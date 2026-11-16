# Syncing Dozo with upstream (Rakazo)

## Fork model

- `upstream-main`: pristine copy of `upstream/main` (github.com/elie222/rakazo). Only ever fast-forwarded.
- `main`: ours = upstream + new files. Published, so we merge and never rebase.
- `sync/upstream-<sha>`: short-lived branch where `upstream-main` is merged into `main` for review.
- Committed: only new files (`dozo/**`, `Makefile`, `.github/workflows/dozo-*.yml`, our UI files).
  No upstream file is edited. Fork health = number of upstream files that differ from
  the merge base with `upstream-main` outside our paths and outside the one allowed edit (the marked block of the root
  `README.md`); `make olc` fails when it is not 0.
- Fork-only files inside upstream directories are named `dozo-*` (under `apps/` and `packages/`).
  They count as ours: `sync.sh` leaves them out of fork health, lists how many there are in its
  summary, and refuses to run (exit 2) if upstream ever ships a `dozo-*` file of its own. An
  upstream merge cannot delete or overwrite them because upstream does not have them. The few
  upstream files they hook into are reached only by anchored rules in `dozo/brand/brand.json`.
- Applied at build time, never committed: the Rakazo-to-Dozo rename. `dozo/docker/build.sh stage`
  copies the tree to `dozo/.stage/src`, `brand` runs `dozo/brand/apply.mjs` then the leak gate
  `check.mjs`. Technical identifiers (`@rakazo/*`, `RAKAZO_*`, DB names, headers, cookies, the
  `rakazo://` scheme) are never renamed.

## Procedure

1. `dozo/sync.sh --dry-run` shows range, commit count, predicted conflicts, fork health. Changes nothing.
2. `dozo/sync.sh` (clean tree required; `--fast` runs only `make olc`). It fast-forwards
   `upstream-main`, creates `sync/upstream-<sha>` from `main`, merges with a merge commit, runs
   `make qa` (its first step is `make olc`). It never pushes and never touches `main`.
3. Review the branch, push it, open a PR into `main` (`dozo-gate` runs on it), merge with a merge
   commit. Never squash or rebase: that would re-apply upstream's commits as new ones.
4. CI does the same daily: `.github/workflows/dozo-sync.yml`. It needs the secret `DOZO_SYNC_TOKEN`
   (workflows scope) and an `upstream-main` branch on origin. Bootstrap once from a clone that has
   the `upstream` remote: push `upstream-main` to origin.

## When it fails

Exit code 2 means refused, conflict or a failed gate (the branch is left for inspection); exit 1
means the merge failed for a reason other than a conflict (git's message is printed, branch removed).

**Merge conflict.** Reported only when git left unmerged paths. The script prints git's output,
aborts the merge, removes the sync branch and lists the files.
Conflicts are only expected in files we own. If an upstream file conflicts, someone committed an
edit to it. Do not resolve it on the sync branch: find the edit (`git log main -- <file>`), move
the change into a new file or into the codemod, revert the edit on `main`, run the sync again.
If `upstream-main` is refused as non-fast-forward, upstream rewrote history; stop and investigate.

**Brand leak or anchored-rule mismatch** (`dozo-gate` or `make qa` fails at `brand`). Upstream
changed a file the codemod depends on. Run `dozo/docker/build.sh stage` then `brand` and read the
output: a leak lists file and string; a rule mismatch names the rule whose anchor no longer matches.
Fix it in `dozo/brand/brand.json` (or the rule code), never in the upstream file. Commit the fix on
the sync branch, re-run `make olc` and the gate, then merge.

## Before publishing this repository on GitHub

Upstream ships 23 workflows. Disable the ones below in Settings > Actions (or
`gh workflow disable <file>`). Do not delete the files: deleting upstream files causes
modify/delete conflicts on every sync. Disabled workflows keep merging cleanly.

Safe to leave on (no secrets, no publishing):
- `computer-replay.yml`: path-filtered runtime tests on a stock runner.
- `topology-verification.yml`: manual only, no secrets.

Must disable:
- `ci.yml`: on main it publishes images to ghcr, can deploy over SSH (`PRODUCTION_DEPLOY_ENABLED`), pushes EAS updates.
- `publish-server-image.yml`: publishes ghcr images under our repository name on `v*` tags and from ci.
- `release-desktop.yml`: builds signed desktop releases on tags, needs Apple signing secrets.
- `release-mobile.yml`, `release-android-apk.yml`, `release-google-play.yml`: store and release uploads, need EAS/App Store/Play secrets.
- `preview-deploy.yml`, `preview-cleanup.yml`: deploy and delete Fly.io preview apps with upstream's Fly token.
- `translation-catalogs.yml`: pushes a branch and opens a PR with `GH_DEPENDENCY_UPDATES_PAT`.
- `weekly-dependencies.yml`, `model-catalog-bump.yml`: push commits and PRs with that PAT, call Codex.
- `pr-screenshots.yml`: bot commits with the PAT, needs Claude/Codex tokens and S3.
- `issue-triage.yml`: needs `CLAUDE_CODE_OAUTH_TOKEN`, labels issues automatically.
- `nightly-verification.yml`, `playwright.yml`, `publish-playwright-report.yml`: need S3 secrets; the first runs nightly and would fail.

Irrelevant (disable to save runner minutes and noise):
- `preview-build.yml`: builds an image only `preview-deploy.yml` consumes.
- `desktop-macos-screenshot.yml`, `mobile-android-screenshots.yml`: desktop/mobile are out of phase 1.
- `www-indexnow.yml`: pings IndexNow for rakazo.com after a Vercel deploy.
- `review-bot.yml`: hands off between Qodo/CodeRabbit/Greptile, which we do not use.

Our `dozo-gate.yml` is the PR gate; `dozo-sync.yml` is the daily sync. If we later want upstream's
tests back, re-enable `ci.yml` only after removing its publish/deploy paths in a way that survives
merges (for example repository variables), not by editing the file.
