# dozo/metrics: `make olcum`

Measures code quality and readability with established tools at their own defaults, scores both
0-100, and compares the result with the committed `baseline.json`. The targets (both fork scores
at least 90) apply to the fork's own files; the whole repository is tracked only. The formula,
the baseline values and the jobs that would raise each low score are in the generated
[REPORT.md](REPORT.md). The token benchmark beside it (`token-kiyas.sh`, `make token-kiyas`) is
separate and shares nothing with it.

## Running it

- `make olcum`: measures, prints every score that moved since `baseline.json`, rewrites
  `baseline.json` and `REPORT.md`, and ends with `OLCUM: kalite=NN okunabilirlik=NN (fork)`.
  Commit both files when the new numbers are the ones to keep.
- `make olcum OLCUM_FLAGS=--gate`: the same, but a fork composite lower than the baseline's exits 2
  and leaves both files as they were.
- Exit codes: 0 measured; 2 a step could not run (no number is left out) or the gate fell; 64 usage.
- Every container is capped at 3 CPUs and 6 GB (`DOZO_OLCUM_CPUS`, `DOZO_OLCUM_MEMORY`) and the
  test runners use as many workers, so the host keeps room for other work. Most of the time goes to
  upstream's unit suite with coverage. It is not part of
  `make olc` or `make qa`, and it does not touch the default stage, its lock or the `dozo-qa-deps`
  volume, so it can run beside them.
- `tr-server-messages.mjs --root <branded tree> [--list]`: counts the server's fixed refusals
  (API, database layer, computer adapters) a Turkish UI cannot say in Turkish: neither in the
  branded Turkish catalog nor carried by a plan-limit code. Run it in the Node image on a staged,
  branded tree before and after a change; `--list` names them. Separate from `make olcum`.

## What runs where

`olcum.sh` (host) builds the `dozo-olcum:local` image (`Dockerfile`: the Node image, git, jq,
python3, age, shellcheck, and the tools pinned in `tools/package-lock.json`), stages and brands the
working tree into `dozo/.stage/olcum` (`DOZO_OLCUM_STAGE_DIR` moves it) and pipes the files git
lists into the container. There `collect.sh` syncs both trees into the `dozo-olcum-deps` volume and
installs their dependencies when a lockfile changed; `collect.mjs` runs the steps in `static.mjs`
and `dynamic.mjs` and writes per-file results to `dozo/.stage/olcum/out/measures.json`.
`report.mjs` scores them with `score.mjs`, the one definition of every weight, conversion and
threshold, which `score.test.mjs` checks on a hand-made measurement before each run.

Nothing is installed on the host. `docker volume rm dozo-olcum-deps` starts cold (the first run
installs both dependency trees, a few minutes more).
