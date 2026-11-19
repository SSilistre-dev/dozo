# Code measurement (`make olcum`)

Written by `dozo/metrics/report.mjs` at commit c05d7a325; do not edit. Target: both fork scores >= 90.

| Set | Quality | Readability |
| --- | --- | --- |
| fork (dozo/ and dozo-* files) | 91.4 | 98.4 |
| whole repository | 87.0 | 95.7 |

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
| types | 100.0 | files 175, dirty 0, findings 0 | 100.0 | files 4484, dirty 1, findings 1 |
| lint | 96.1 | files 232, dirty 9, findings 41 | 99.6 | files 4489, dirty 18, findings 72 |
| tests | 100.0 | passed 1399, failed 0, skipped 19 | 100.0 | passed 29986, failed 13, skipped 1328 |
| lineCoverage | 99.8 | covered 4243, total 4251 | 81.8 | covered 97089, total 118698 |
| branchCoverage | 97.4 | covered 2396, total 2459 | 76.8 | covered 84081, total 109493 |
| security | 25.0 | info 0, low 4, moderate 9, high 11, critical 0, rating D | 25.0 | info 0, low 4, moderate 9, high 11, critical 0, rating D |
| shell | 100.0 | files 17, dirty 0, findings 0 | 78.8 | files 66, dirty 14, findings 34 |
| checks | 94.7 | passed 90, failed 5, skipped 0 | 94.7 | passed 90, failed 5, skipped 0 |
| complexity | 98.9 | functions 1345, over 15, max 51 | 97.8 | functions 33715, over 726, max 348 |
| functionLength | 97.0 | functions 1345, over 40, max 459 | 94.8 | functions 33715, over 1765, max 1347 |
| fileLength | 91.9 | files 124, dirty 10, findings 4849 | 81.0 | files 2444, dirty 464, findings 278538 |
| duplication | 100.0 | lines 15734, duplicated 245, percent 1.56, rating A | 100.0 | lines 473722, duplicated 7553, percent 1.59, rating A |
| deadCode | 100.0 | files 124, dirty 0, findings 0 | 90.5 | files 2444, dirty 233, findings 330 |
| format | 100.0 | files 232, dirty 0, findings 0 | 100.0 | files 4489, dirty 0, findings 0 |

Cognitive complexity per function (functions in each bucket):

| Set | 0 | 1-5 | 6-10 | 11-15 | 16-25 | >25 |
| --- | --- | --- | --- | --- | --- | --- |
| fork | 880 | 398 | 44 | 8 | 7 | 8 |
| all | 18934 | 11930 | 1574 | 551 | 398 | 328 |

Tracked, not scored: web startup bundle 871.6 kB of its 900 kB budget (scripts/checks/bundle-size.mjs).

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
