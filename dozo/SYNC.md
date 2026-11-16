# Syncing Dozo with upstream (Rakazo)

## Fork model

- `upstream-main`: pristine copy of `upstream/main` (github.com/elie222/rakazo). Only ever fast-forwarded.
- `main`: ours = upstream + new files. Published, so we merge and never rebase.
- `sync/upstream-<sha>`: short-lived branch (`<sha>` is 9 characters) where `upstream-main` is merged into
  `main` for review.
- Committed: only new files (`dozo/**`, `Makefile`, `.github/workflows/dozo-*.yml`, `dozo-*` source files).
  No upstream file is edited, except the marked block at the top of the root `README.md`.
- Fork-only source files inside upstream directories are named `dozo-*` (under `apps/` and
  `packages/`). `sync.sh` lists how many there are and refuses to run (exit 2) if upstream ever ships a
  `dozo-*` file of its own. An upstream merge cannot delete or overwrite ours because upstream does not
  have them. The few upstream files they hook into are reached only by anchored rules in
  `dozo/brand/brand.json`.
- Applied at build time, never committed: the Rakazo-to-Dozo rename (`dozo/docker/README.md`,
  `dozo/brand/README.md`).

**Fork health** = the number of upstream files that our tree edited, deleted or retyped, compared with
the merge base with `upstream-main`, leaving out `dozo/`, `Makefile` and the marked block of `README.md`.
Added files are ours and do not count. One computation, `gate.sh upstream-edits <base> [tree]`, serves
`make olc` (working tree against the merge base with `upstream-main`; it fails above 0 and lists the
files) and `sync.sh` (the merge result against the upstream commit it contains; it prints the count and
warns above 0 without failing).

## Prerequisites (once per clone)

```
git remote add upstream https://github.com/elie222/rakazo.git
git fetch upstream main
git branch upstream-main upstream/main
```

`make olc` fails without the `upstream-main` ref, locally and in CI, and `sync.sh` refuses to run
without the `upstream` remote and the branch. For CI, origin also needs `upstream-main`: push it once
(`git push origin upstream-main`). `dozo-gate` fails when origin has none.

## Procedure

1. `dozo/sync.sh --dry-run` shows range, commit count, predicted conflicts and fork health. It needs no
   clean tree and changes no branch, index or file; its `git fetch` does update the remote-tracking ref
   `refs/remotes/upstream/main`. It exits 2 when it predicts conflicts.
2. `dozo/sync.sh` (clean tree required). It fetches, fast-forwards `upstream-main`, creates
   `sync/upstream-<sha>` from `main`, merges with a merge commit, then runs `make qa` (its first step is
   `make olc`). `--fast` runs only `make olc`. With a Makefile, a missing `make` or a missing target (`qa`, or
   `olc` with `--fast`) fails the sync (exit 2); a tree without any Makefile has no gates and gets a
   notice. It never pushes and never touches `main`. On success you are left on the sync branch.
3. Review the branch, push it, open a PR into `main` (`dozo-gate` runs on it), merge with a merge
   commit. Never squash or rebase: that would re-apply upstream's commits as new ones.
4. CI does the same daily: `.github/workflows/dozo-sync.yml` runs at 05:37 UTC and on manual dispatch
   (input `fast`, default true). The scheduled run always passes `--fast`, so it runs `make olc` only;
   only a manual dispatch with `fast` off runs the full `make qa` on the runner. It then force-pushes the sync branch, fast-forwards
   `upstream-main` on origin (also when `main` already had upstream's tip and there is no sync
   branch: a separate step pushes it, without `--force`), creates the label `upstream-sync` if missing, closes older open PRs with
   that label (deleting their branches) and opens or updates the PR. If `sync.sh` fails, nothing is
   published and the job fails. It needs:
   - the secret `DOZO_SYNC_TOKEN` (workflows scope; upstream changes `.github/workflows`);
   - `upstream-main` on origin (see Prerequisites);
   - optionally the repository variable `DOZO_UPSTREAM_URL`, the upstream clone URL (default
     `https://github.com/elie222/rakazo.git`).

   What `dozo-gate` runs on the PR is in `dozo/README.md` (Status and known limits).

## Exit codes of sync.sh

| Code | When |
| --- | --- |
| 0 | `--help`; main already contains upstream (nothing to merge; `upstream-main` is fast-forwarded unless `--dry-run`); a clean `--dry-run`; a clean merge whose gates pass |
| 1 | unknown flag; not in a git repository; no `upstream` remote; no `main` or `upstream-main` branch; dirty tree (real run); `main` and upstream share no history; fork health cannot be computed; `sync/upstream-<sha>` already exists; `git merge-tree` failed (dry run); the merge failed without conflicts (git's message is printed, branch removed). A failing `git fetch` ends the script with git's own status (128) |
| 2 | `upstream-main` is not an ancestor of `upstream/main` (upstream rewrote history; stop and investigate); upstream ships a `dozo-*` file; `--dry-run` predicts conflicts; a real merge conflicts (merge aborted, branch removed, you are back on your branch); a gate fails or cannot run: no `make`, no `qa`/`olc` target (**branch kept** for inspection, not pushed) |
| 129, 130, 143 | SIGHUP, SIGINT, SIGTERM. Before the merge commit exists the half-made branch is removed and you are back on the original branch ("stopped early"). During the gates the branch stays |

In every case after the fast-forward, `upstream-main` stays at the new tip, including after a conflict.
The script runs the gates with `DOZO_QA_STEPS`, `DOZO_SKIP_BRAND` and `DOZO_UPSTREAM_REF` unset, so a
"partial" verdict cannot pass here.

## When it fails

**Merge conflict.** Reported only when git left unmerged paths. The script prints git's output,
aborts the merge, removes the sync branch and lists the files. Conflicts are only expected in files we
own. If an upstream file conflicts, someone committed an edit to it. Do not resolve it on the sync
branch: find the edit (`git log main -- <file>`), move the change into a new file or into the codemod,
revert the edit on `main`, run the sync again.

**Brand leak or anchored-rule mismatch** (`dozo-gate` or `make qa` fails at `brand`). Upstream changed a
file the codemod depends on. Run `dozo/docker/build.sh stage` then `brand` and read the output: a leak
lists file and string; a rule mismatch names the rule whose anchor no longer matches. Fix it in
`dozo/brand/brand.json` (or the rule code), never in the upstream file. Commit the fix on the sync
branch, re-run `make olc` and the gate, then merge.

## Upstream's GitHub workflows

Status: not done (what is published: `dozo/README.md`, Status and known limits). Upstream's
workflows are present and enabled in the tree. Do this before anything runs on GitHub: turn Actions off for the new repository (Settings > Actions >
General) before the first push, disable the workflows below in Settings > Actions (or
`gh workflow disable <file>`), then turn Actions back on. Do not delete the files: deleting upstream
files causes modify/delete conflicts on every sync. Disabled workflows keep merging cleanly. Keep
`dozo-gate.yml` and `dozo-sync.yml` enabled.

Upstream ships 23 workflows. Re-check after every sync: a new upstream workflow arrives enabled
and would run on the first push. `make olc` prints `upstream workflows=<n>` (the files under
`.github/workflows` not named `dozo-*`) in its rules line; a different number means one was added or
removed. List them (`ls .github/workflows`), sort the new one into the groups below and disable it
the same way before the sync branch is pushed. The line informs, it does not fail the gate.

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
- `weekly-dependencies.yml`: pushes commits and PRs with that PAT and calls Codex.
- `model-catalog-bump.yml`: pushes commits and PRs with that PAT.
- `pr-screenshots.yml`: bot commits with the PAT, runs Codex or Claude, needs `CLAUDE_CODE_OAUTH_TOKEN` and S3 secrets.
- `issue-triage.yml`: needs `CLAUDE_CODE_OAUTH_TOKEN`, labels issues automatically.
- `nightly-verification.yml`, `playwright.yml`, `publish-playwright-report.yml`: need S3 secrets; the first runs nightly and would fail.

Irrelevant (disable to save runner minutes and noise):
- `preview-build.yml`: builds an image only `preview-deploy.yml` consumes.
- `desktop-macos-screenshot.yml`, `mobile-android-screenshots.yml`: desktop/mobile are out of phase 1.
- `www-indexnow.yml`: pings IndexNow for rakazo.com after a Vercel deploy.
- `review-bot.yml`: hands off between Qodo/CodeRabbit/Greptile, which we do not use.

If we later want upstream's tests back, re-enable `ci.yml` only after removing its publish/deploy
paths in a way that survives merges (for example repository variables), not by editing the file.
