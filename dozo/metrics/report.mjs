// Scores a measurement, prints how it moved from the committed baseline, then writes the new
// baseline.json and REPORT.md. Usage: node report.mjs <measures.json> <commit> [--gate]
// Exit 0; 2 with --gate when a fork composite score fell (the baseline is then left as it was); 64 usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEASURES, SETS, scoreSet } from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "baseline.json");
const TARGET = 90;
const SET_NAMES = { fork: "fork (dozo/ and dozo-* files)", all: "whole repository" };
const LIMITS = [
  "Upstream's tests run on the unbranded tree, the fork's dozo-* tests on the branded one (as `gate.sh unit`); a fork test's unbranded result is dropped.",
  "Tests that need Postgres, a desktop or a network service skip themselves here as they do in upstream's unit job; they count as skipped.",
  "Coverage of dozo/ scripts counts only the modules a dozo/ test loads (Node's coverage lists no others). Upstream's coverage counts every source file next to its tests, loaded or not.",
  "tsc does not see dozo/e2e (Playwright compiles it); `make e2e` does.",
  "knip runs without a configuration, so a dozo/ script started from a shell script or a Makefile (an entry point knip cannot see) is reported as an unused file; the fork's deadCode score takes knip's word and is understated by them. Check a deadCode job before acting on it.",
  "`pnpm audit` and `pnpm checks` cover the whole repository: both sets get the same value.",
];

const round = (n) => (n === null ? null : Math.round(n * 10) / 10);
const shown = (n) => (n === null ? "n/a" : n.toFixed(1));

function summarize(measures) {
  const sets = {};
  for (const [name, inScope] of Object.entries(SETS)) {
    const { quality, readability, results } = scoreSet(measures, inScope);
    sets[name] = {
      quality: round(quality),
      readability: round(readability),
      measures: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [id, { score: round(r.score), ...r.raw }]),
      ),
      jobs: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.jobs.slice(0, 5)])),
    };
  }
  return sets;
}

/** One line per score that moved since the previous baseline. */
function diff(previous, sets) {
  const lines = [];
  for (const [name, set] of Object.entries(sets)) {
    const old = previous?.sets?.[name];
    const pairs = [
      ["quality", old?.quality, set.quality],
      ["readability", old?.readability, set.readability],
      ...MEASURES.map((d) => [d.id, old?.measures?.[d.id]?.score, set.measures[d.id].score]),
    ];
    for (const [id, before, after] of pairs) {
      if (before === undefined || before === after) continue;
      const verdict =
        before === null || after === null ? "changed" : after > before ? "better" : "worse";
      lines.push(`[olcum] ${name} ${id}: ${shown(before)} -> ${shown(after)} (${verdict})`);
    }
  }
  return lines;
}

function fell(previous, sets) {
  const old = previous?.sets?.fork;
  return (
    Boolean(old) && (sets.fork.quality < old.quality || sets.fork.readability < old.readability)
  );
}

const rawText = (m) =>
  Object.entries(m)
    .filter(([k, v]) => k !== "score" && typeof v !== "object")
    .map(([k, v]) => `${k} ${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v}`)
    .join(", ");

function formulaSection() {
  const rows = MEASURES.map(
    (d) => `| ${d.id} | ${d.group} | ${d.weight} | ${d.tool} | ${d.conversion} | ${d.threshold} |`,
  );
  return [
    "## How the scores are computed",
    "",
    "Each sub-measure is turned into 0-100 as the table says. A composite is the weighted mean of its group:",
    "`quality = sum(weight x score) / sum(weight)` over the quality rows, the same for readability. A",
    "sub-measure with nothing in scope (score n/a) drops out and the remaining weights are used. Thresholds",
    "are the tools' own defaults or a published rating, never tuned to this repository. The last line of",
    "`make olcum` shows the fork composites rounded down.",
    "",
    "| Sub-measure | Group | Weight | Tool | 0-100 | Threshold (source) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];
}

function valuesSection(sets) {
  const rows = MEASURES.map((d) => {
    const f = sets.fork.measures[d.id];
    const a = sets.all.measures[d.id];
    return `| ${d.id} | ${shown(f.score)} | ${rawText(f)} | ${shown(a.score)} | ${rawText(a)} |`;
  });
  const dist = (set) => sets[set].measures.complexity.distribution;
  return [
    "## Baseline values",
    "",
    "| Sub-measure | Fork | Fork raw | All | All raw |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Cognitive complexity per function (functions in each bucket):",
    "",
    `| Set | ${Object.keys(dist("fork")).join(" | ")} |`,
    `| --- |${Object.keys(dist("fork"))
      .map(() => " --- |")
      .join("")}`,
    ...["fork", "all"].map((s) => `| ${s} | ${Object.values(dist(s)).join(" | ")} |`),
  ];
}

function jobsSection(sets) {
  const below = MEASURES.filter(
    (d) => sets.fork.measures[d.id].score !== null && sets.fork.measures[d.id].score < TARGET,
  );
  const blocks = below.flatMap((d) => [
    `### ${d.id} (${shown(sets.fork.measures[d.id].score)})`,
    "",
    ...sets.fork.jobs[d.id].map((j) => `- ${j.target}: +${j.gain.toFixed(1)}`),
    "",
  ]);
  return [
    "## Fork sub-measures under 90: the five jobs worth the most",
    "",
    "Points are the sub-measure's own gain from fixing that one item; its weight carries it into the composite.",
    "",
    ...(blocks.length ? blocks : ["None.", ""]),
  ];
}

function reportText(baseline) {
  const { sets, bundle } = baseline;
  return [
    "# Code measurement (`make olcum`)",
    "",
    `Written by \`dozo/metrics/report.mjs\` at commit ${baseline.commit}; do not edit. Target: both fork scores >= ${TARGET}.`,
    "",
    "| Set | Quality | Readability |",
    "| --- | --- | --- |",
    ...Object.entries(sets).map(
      ([name, s]) => `| ${SET_NAMES[name]} | ${shown(s.quality)} | ${shown(s.readability)} |`,
    ),
    "",
    "Fork: every file dozo/NOTICE lists as a Dozo file. Whole repository: every file git lists. Code files are",
    "TypeScript and JavaScript outside the directories biome.jsonc leaves out; source files are code files that are",
    "not tests (`*.test.*`, `*.spec.*`, `*.test-support.*`).",
    "",
    ...formulaSection(),
    "",
    ...valuesSection(sets),
    "",
    `Tracked, not scored: web startup bundle ${bundle.kb} kB of its ${bundle.budgetKb} kB budget (scripts/checks/bundle-size.mjs).`,
    "",
    ...jobsSection(sets),
    "## Known limits",
    "",
    ...LIMITS.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

const [measuresPath, commit, ...flags] = process.argv.slice(2);
if (!commit || flags.some((f) => f !== "--gate")) {
  console.error("usage: report.mjs <measures.json> <commit> [--gate]");
  process.exit(64);
}
const measures = JSON.parse(readFileSync(measuresPath, "utf8"));
const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const sets = summarize(measures);
const baseline = { commit, bundle: measures.bundle, sets };
for (const line of diff(previous, sets)) console.log(line);
const gateFailed = flags.includes("--gate") && fell(previous, sets);
if (gateFailed)
  console.log("[olcum] a fork score fell: baseline.json and REPORT.md left as they were");
else {
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(path.join(HERE, "REPORT.md"), reportText(baseline));
}
console.log(
  `OLCUM: kalite=${Math.floor(sets.fork.quality)} okunabilirlik=${Math.floor(sets.fork.readability)} (fork)`,
);
process.exit(gateFailed ? 2 : 0);
