# Code measurement (`make olcum`)

Written by `dozo/metrics/report.mjs` at commit 7e2475c91; do not edit. Target: both fork scores >= 90.

| Set | Quality | Readability |
| --- | --- | --- |
| fork (dozo/ and dozo-* files) | 91.8 | 98.5 |
| whole repository | 87.3 | 95.8 |

Fork: every file dozo/NOTICE lists as a Dozo file. Whole repository: every file git lists. Code files are
TypeScript and JavaScript outside the directories biome.jsonc leaves out; source files are code files that are
not tests (`*.test.*`, `*.spec.*`, `*.test-support.*`).

## How the scores are computed

Each sub-measure is turned into 0-100 as the table says. A composite is the weighted mean of its group:
`quality = sum(weight x score) / sum(weight)` over the quality rows, the same for readability. A
sub-measure with nothing in scope (score n/a) drops out and the remaining weights are used. Thresholds
are the tools' own defaults or a published rating, never tuned to this repository. The last line of
`make olcum` shows the fork composites rounded down.

| Sub-measure | Group | Weight | Tool | 0-100 | Threshold (source) |
| --- | --- | --- | --- | --- | --- |
| types | quality | 25 | tsc (each package's `check` tsconfig, branded tree) | share of type-checked files with no tsc error | 0 errors: tsc's own pass/fail |
| lint | quality | 15 | Biome, the repository's biome.jsonc | share of code files with no lint error or warning | the rules and severities biome.jsonc sets |
| tests | quality | 20 | Vitest and node --test | passed / (passed + failed); skipped tests are reported, not scored | every test passes |
| lineCoverage | quality | 10 | V8 coverage (Vitest, node --test) | covered lines / lines, in percent | the percentage itself |
| branchCoverage | quality | 10 | V8 coverage (Vitest, node --test) | covered branches / branches, in percent | the percentage itself |
| security | quality | 10 | pnpm audit (whole lockfile; same value for both sets) | rating A-E by the worst advisory, scored 100/75/50/25/0 | SonarQube security rating: A none, B low, C moderate, D high, E critical |
| shell | quality | 5 | shellcheck 0.11 | share of *.sh files with no finding | shellcheck's default severity (style and up) |
| checks | quality | 5 | `pnpm checks` (scripts/checks; same value for both sets) | passed / (passed + failed) | every check passes |
| complexity | readability | 30 | eslint-plugin-sonarjs cognitive-complexity | share of functions with cognitive complexity <= 15 | 15: the rule's default (SonarSource) |
| functionLength | readability | 15 | ESLint max-lines-per-function | share of functions of <= 50 lines | 50: the rule's default |
| fileLength | readability | 10 | ESLint max-lines | share of source files of <= 300 lines | 300: the rule's default |
| duplication | readability | 20 | jscpd (min 50 tokens, 5 lines: its defaults) | duplicated lines / lines of source, rated A-E and scored 100/75/50/25/0 | SonarQube duplication rating: A < 3 %, B < 5, C < 10, D < 20, E from 20 |
| deadCode | readability | 10 | knip (unused files, exports, types, members) | share of source files with no knip finding | knip's defaults plus the entry points it cannot see (dozo/metrics/knip.config.mjs) |
| format | readability | 15 | Biome formatter and import sorting | share of code files Biome would not rewrite | the repository's biome.jsonc |

## Baseline values

| Sub-measure | Fork | Fork raw | All | All raw |
| --- | --- | --- | --- | --- |
| types | 100.0 | files 241, dirty 0, findings 0 | 100.0 | files 4551, dirty 1, findings 1 |
| lint | 97.0 | files 298, dirty 9, findings 41 | 99.6 | files 4555, dirty 18, findings 72 |
| tests | 100.0 | passed 1617, failed 0, skipped 29 | 99.9 | passed 30190, failed 27, skipped 1338 |
| lineCoverage | 99.8 | covered 4996, total 5005 | 81.9 | covered 97836, total 119452 |
| branchCoverage | 97.5 | covered 2923, total 2999 | 76.9 | covered 84594, total 110033 |
| security | 25.0 | info 0, low 4, moderate 9, high 11, critical 0, rating D | 25.0 | info 0, low 4, moderate 9, high 11, critical 0, rating D |
| shell | 100.0 | files 20, dirty 0, findings 0 | 79.7 | files 69, dirty 14, findings 34 |
| checks | 100.0 | passed 95, failed 0, skipped 0 | 100.0 | passed 95, failed 0, skipped 0 |
| complexity | 99.1 | functions 1593, over 15, max 51 | 97.9 | functions 33963, over 726, max 348 |
| functionLength | 96.8 | functions 1593, over 51, max 465 | 94.8 | functions 33963, over 1776, max 1347 |
| fileLength | 92.9 | files 156, dirty 11, findings 5244 | 81.2 | files 2476, dirty 465, findings 278933 |
| duplication | 100.0 | lines 19035, duplicated 301, percent 1.58, rating A | 100.0 | lines 477023, duplicated 7609, percent 1.60, rating A |
| deadCode | 100.0 | files 156, dirty 0, findings 0 | 90.6 | files 2476, dirty 233, findings 330 |
| format | 100.0 | files 298, dirty 0, findings 0 | 100.0 | files 4555, dirty 0, findings 0 |

Cognitive complexity per function (functions in each bucket):

| Set | 0 | 1-5 | 6-10 | 11-15 | 16-25 | >25 |
| --- | --- | --- | --- | --- | --- | --- |
| fork | 1022 | 494 | 51 | 11 | 7 | 8 |
| all | 19076 | 12026 | 1581 | 554 | 398 | 328 |

Tracked, not scored: web startup bundle 873.8 kB of its 900 kB budget (scripts/checks/bundle-size.mjs).

## Fork sub-measures under 90: the five jobs worth the most

Points are the sub-measure's own gain from fixing that one item; its weight carries it into the composite.

### security (25.0)

- minimatch (high): +5.0
- nanoid (high): +5.0
- tar (high): +5.0
- brace-expansion (high): +5.0
- joi (high): +5.0

## Known limits

- Upstream's tests run on the unbranded tree, the fork's dozo-* tests on the branded one (as `gate.sh unit`); a fork test's unbranded result is dropped.
- Tests that need Postgres, a desktop or a network service skip themselves here as they do in upstream's unit job; they count as skipped.
- Coverage of dozo/ scripts counts only the modules a dozo/ test loads (Node's coverage lists no others). Upstream's coverage counts every source file next to its tests, loaded or not.
- tsc does not see dozo/e2e (Playwright compiles it); `make e2e` does.
- knip runs on the unbranded tree. dozo/metrics/knip.config.mjs adds the entry points it cannot see: dozo/ scripts started from a shell script or an HTML page, and the files a brand rule requires (imported only in the branded tree). knip does not report the unused exports of an entry file, so those of a brand-required file are not counted.
- `pnpm audit` and `pnpm checks` cover the whole repository: both sets get the same value.
