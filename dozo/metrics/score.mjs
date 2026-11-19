// The two composite scores of `make olcum` and every sub-measure behind them. This table is the one
// definition: REPORT.md prints its weights, conversions and threshold sources from here.
// Each measure returns { raw, score (0-100, or null when nothing is in scope), jobs }, where a job is
// a file or package whose fix would raise that sub-measure by `gain` points.

/** The fork's own files, as dozo/NOTICE lists them (the code-bearing patterns). */
export const isFork = (file) =>
  file.startsWith("dozo/") ||
  /^(apps|packages|infra)\/(.+\/)?dozo-[^/]*$/.test(file) ||
  /^packages\/db\/prisma\/migrations\/[^/]*_dozo_[^/]*\//.test(file);

const RATINGS = ["A", "B", "C", "D", "E"];
const RATING_SCORE = { A: 100, B: 75, C: 50, D: 25, E: 0 };
const SEVERITIES = ["critical", "high", "moderate", "low"]; // npm severity, worst first
const COMPLEXITY_MAX = 15;
const FUNCTION_LINES_MAX = 50;
const FILE_LINES_MAX = 300;
const BUCKETS = [
  ["0", 0],
  ["1-5", 5],
  ["6-10", 10],
  ["11-15", 15],
  ["16-25", 25],
  [">25", Number.POSITIVE_INFINITY],
];

const pct = (part, whole) => (whole ? (100 * part) / whole : null);
const sum = (values) => values.reduce((a, b) => a + b, 0);

/** Share of files with no finding; each file with one is a job worth 100/files. */
function cleanFiles(files, counts) {
  const dirty = files.filter((f) => counts[f] > 0).sort((a, b) => counts[b] - counts[a]);
  return {
    raw: { files: files.length, dirty: dirty.length, findings: sum(dirty.map((f) => counts[f])) },
    score: pct(files.length - dirty.length, files.length),
    jobs: dirty.map((f) => ({ target: `${f} (${counts[f]})`, gain: 100 / files.length })),
  };
}

/** Share of passed tests among passed and failed; skipped ones are reported, not scored. */
function testRate(perFile) {
  const totals = { passed: 0, failed: 0, skipped: 0 };
  for (const c of Object.values(perFile)) for (const k of Object.keys(totals)) totals[k] += c[k];
  const run = totals.passed + totals.failed;
  const jobs = Object.entries(perFile)
    .filter(([, c]) => c.failed > 0)
    .map(([f, c]) => ({ target: `${f} (${c.failed} failed)`, gain: (100 * c.failed) / run }));
  return { raw: totals, score: pct(totals.passed, run), jobs };
}

function coverage(perFile, kind) {
  const entries = Object.entries(perFile).map(([f, c]) => [f, c[kind][0], c[kind][1]]);
  const covered = sum(entries.map((e) => e[1]));
  const total = sum(entries.map((e) => e[2]));
  const jobs = entries
    .filter(([, c, t]) => t > c)
    .map(([f, c, t]) => ({
      target: `${f} (${t - c} of ${t} uncovered)`,
      gain: (100 * (t - c)) / total,
    }));
  return { raw: { covered, total }, score: pct(covered, total), jobs };
}

function securityRating(counts) {
  const worst = SEVERITIES.findIndex((s) => counts[s] > 0);
  return worst === -1 ? "A" : RATINGS[SEVERITIES.length - worst];
}

function security(audit) {
  const rating = securityRating(audit.counts);
  const order = (a) => SEVERITIES.indexOf(a.severity);
  const worst = audit.advisories.filter(
    (a) => order(a) === Math.min(...audit.advisories.map(order)),
  );
  const modules = [...new Set(worst.map((a) => a.module))];
  const next =
    RATING_SCORE[RATINGS[Math.max(0, RATINGS.indexOf(rating) - 1)]] - RATING_SCORE[rating];
  const jobs = modules.map((m) => ({
    target: `${m} (${worst[0].severity})`,
    gain: next / modules.length,
  }));
  return { raw: { ...audit.counts, rating }, score: RATING_SCORE[rating], jobs };
}

/** SonarQube's duplication rating bands: A < 3 %, B < 5, C < 10, D < 20, E from 20. */
function duplicationRating(percent) {
  const band = [3, 5, 10, 20].findIndex((limit) => percent < limit);
  return band === -1 ? "E" : RATINGS[band];
}

function duplication(lines, duplicated) {
  const total = sum(Object.values(lines));
  const dup = sum(Object.keys(lines).map((f) => duplicated[f] ?? 0));
  const score = (d) => RATING_SCORE[duplicationRating(pct(d, total) ?? 0)];
  const jobs = Object.keys(lines)
    .filter((f) => duplicated[f] > 0)
    .sort((a, b) => duplicated[b] - duplicated[a])
    .map((f) => ({
      target: `${f} (${duplicated[f]} lines)`,
      gain: score(dup - duplicated[f]) - score(dup),
    }));
  const percent = pct(dup, total);
  return {
    raw: { lines: total, duplicated: dup, percent, rating: duplicationRating(percent ?? 0) },
    score: total ? score(dup) : null,
    jobs,
  };
}

/** Share of functions within a limit; each file is a job worth its functions over the limit. */
function functionsWithin(perFile, key, limit, histogram) {
  const values = Object.values(perFile).flatMap((e) => e[key]);
  const functions = sum(Object.values(perFile).map((e) => e.lengths.length));
  const over = values.filter((v) => v > limit).length;
  const jobs = Object.entries(perFile)
    .map(([f, e]) => [f, e[key].filter((v) => v > limit)])
    .filter(([, o]) => o.length)
    .sort((a, b) => b[1].length - a[1].length || Math.max(...b[1]) - Math.max(...a[1]))
    .map(([f, o]) => ({
      target: `${f} (${o.length} over, max ${Math.max(...o)})`,
      gain: (100 * o.length) / functions,
    }));
  const raw = { functions, over, max: Math.max(0, ...values) };
  if (histogram) raw.distribution = distribution(values, functions);
  return { raw, score: pct(functions - over, functions), jobs };
}

/** Complexity per function in buckets; functions sonarjs does not report have complexity 0. */
function distribution(values, functions) {
  const counts = Object.fromEntries(BUCKETS.map(([name]) => [name, 0]));
  counts["0"] = functions - values.length;
  for (const v of values) counts[BUCKETS.find(([, max]) => v <= max)[0]]++;
  return counts;
}

const pick = (map, keep) => Object.fromEntries(Object.entries(map).filter(([f]) => keep(f)));

/** Every sub-measure: group, weight, the tool, how its result becomes 0-100, the threshold source. */
export const MEASURES = [
  {
    id: "types",
    group: "quality",
    weight: 25,
    tool: "tsc (each package's `check` tsconfig, branded tree)",
    conversion: "share of type-checked files with no tsc error",
    threshold: "0 errors: tsc's own pass/fail",
    measure: (m, s) => cleanFiles(m.types.checked.filter(s), m.types.errors),
  },
  {
    id: "lint",
    group: "quality",
    weight: 15,
    tool: "Biome, the repository's biome.jsonc",
    conversion: "share of code files with no lint error or warning",
    threshold: "the rules and severities biome.jsonc sets",
    measure: (m, s) => cleanFiles(m.files.code.filter(s), m.biome.lint),
  },
  {
    id: "tests",
    group: "quality",
    weight: 20,
    tool: "Vitest and node --test",
    conversion: "passed / (passed + failed); skipped tests are reported, not scored",
    threshold: "every test passes",
    measure: (m, s) => testRate({ ...pick(m.tests.vitest, s), ...pick(m.tests.node, s) }),
  },
  {
    id: "lineCoverage",
    group: "quality",
    weight: 10,
    tool: "V8 coverage (Vitest, node --test)",
    conversion: "covered lines / lines, in percent",
    threshold: "the percentage itself",
    measure: (m, s) => coverage(pick(m.tests.coverage, s), "lines"),
  },
  {
    id: "branchCoverage",
    group: "quality",
    weight: 10,
    tool: "V8 coverage (Vitest, node --test)",
    conversion: "covered branches / branches, in percent",
    threshold: "the percentage itself",
    measure: (m, s) => coverage(pick(m.tests.coverage, s), "branches"),
  },
  {
    id: "security",
    group: "quality",
    weight: 10,
    tool: "pnpm audit (whole lockfile; same value for both sets)",
    conversion: "rating A-E by the worst advisory, scored 100/75/50/25/0",
    threshold: "SonarQube security rating: A none, B low, C moderate, D high, E critical",
    measure: (m) => security(m.audit),
  },
  {
    id: "shell",
    group: "quality",
    weight: 5,
    tool: "shellcheck 0.11",
    conversion: "share of *.sh files with no finding",
    threshold: "shellcheck's default severity (style and up)",
    measure: (m, s) => cleanFiles(m.files.shell.filter(s), m.shellcheck),
  },
  {
    id: "checks",
    group: "quality",
    weight: 5,
    tool: "`pnpm checks` (scripts/checks; same value for both sets)",
    conversion: "passed / (passed + failed)",
    threshold: "every check passes",
    measure: (m) => testRate({ "scripts/checks": m.checks }),
  },
  {
    id: "complexity",
    group: "readability",
    weight: 30,
    tool: "eslint-plugin-sonarjs cognitive-complexity",
    conversion: "share of functions with cognitive complexity <= 15",
    threshold: "15: the rule's default (SonarSource)",
    measure: (m, s) => functionsWithin(pick(m.functions, s), "complexities", COMPLEXITY_MAX, true),
  },
  {
    id: "functionLength",
    group: "readability",
    weight: 15,
    tool: "ESLint max-lines-per-function",
    conversion: "share of functions of <= 50 lines",
    threshold: "50: the rule's default",
    measure: (m, s) => functionsWithin(pick(m.functions, s), "lengths", FUNCTION_LINES_MAX, false),
  },
  {
    id: "fileLength",
    group: "readability",
    weight: 10,
    tool: "ESLint max-lines",
    conversion: "share of source files of <= 300 lines",
    threshold: "300: the rule's default",
    measure: (m, s) => {
      const files = pick(m.functions, s);
      const over = Object.fromEntries(
        Object.entries(files).map(([f, e]) => [f, e.lines > FILE_LINES_MAX ? e.lines : 0]),
      );
      return cleanFiles(Object.keys(files), over);
    },
  },
  {
    id: "duplication",
    group: "readability",
    weight: 20,
    tool: "jscpd (min 50 tokens, 5 lines: its defaults)",
    conversion: "duplicated lines / lines of source, rated A-E and scored 100/75/50/25/0",
    threshold: "SonarQube duplication rating: A < 3 %, B < 5, C < 10, D < 20, E from 20",
    measure: (m, s) =>
      duplication(
        pick(Object.fromEntries(Object.entries(m.functions).map(([f, e]) => [f, e.lines])), s),
        m.duplication,
      ),
  },
  {
    id: "deadCode",
    group: "readability",
    weight: 10,
    tool: "knip (unused files, exports, types, members)",
    conversion: "share of source files with no knip finding",
    threshold: "knip's defaults plus the entry points it cannot see (dozo/metrics/knip.config.mjs)",
    measure: (m, s) => cleanFiles(m.files.source.filter(s), m.deadCode),
  },
  {
    id: "format",
    group: "readability",
    weight: 15,
    tool: "Biome formatter and import sorting",
    conversion: "share of code files Biome would not rewrite",
    threshold: "the repository's biome.jsonc",
    measure: (m, s) => cleanFiles(m.files.code.filter(s), m.biome.format),
  },
];

/** Weighted mean of the group's sub-scores; a sub-measure with nothing in scope drops out. */
function composite(results, group) {
  const scored = MEASURES.filter((d) => d.group === group && results[d.id].score !== null);
  const weight = sum(scored.map((d) => d.weight));
  return sum(scored.map((d) => d.weight * results[d.id].score)) / weight;
}

/** Scores one set of files: `inScope(file)` decides membership. */
export function scoreSet(measures, inScope) {
  const results = Object.fromEntries(MEASURES.map((d) => [d.id, d.measure(measures, inScope)]));
  return {
    quality: composite(results, "quality"),
    readability: composite(results, "readability"),
    results,
  };
}

export const SETS = { fork: isFork, all: () => true };
