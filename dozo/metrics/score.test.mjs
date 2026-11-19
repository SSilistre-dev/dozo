// The score formula on a small hand-made measurement (olcum.sh runs this before measuring).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isFork, SETS, scoreSet } from "./score.mjs";

const measures = () => ({
  files: {
    code: ["dozo/a.mjs", "apps/web/src/x.ts", "apps/web/src/dozo-y.ts"],
    source: ["dozo/a.mjs", "apps/web/src/x.ts", "apps/web/src/dozo-y.ts"],
    shell: ["dozo/s.sh"],
  },
  types: {
    checked: ["apps/web/src/x.ts", "apps/web/src/dozo-y.ts"],
    errors: { "apps/web/src/x.ts": 2 },
  },
  biome: { lint: { "dozo/a.mjs": 1 }, format: {} },
  functions: {
    "dozo/a.mjs": { lines: 400, lengths: [10, 60], complexities: [3, 20] },
    "apps/web/src/x.ts": { lines: 100, lengths: [5], complexities: [] },
    "apps/web/src/dozo-y.ts": { lines: 50, lengths: [5, 5], complexities: [16] },
  },
  duplication: { "apps/web/src/x.ts": 20 },
  deadCode: {},
  shellcheck: {},
  checks: { passed: 9, failed: 1, skipped: 0 },
  audit: {
    counts: { info: 0, low: 1, moderate: 0, high: 2, critical: 0 },
    advisories: [
      { module: "a", severity: "high" },
      { module: "b", severity: "high" },
      { module: "c", severity: "low" },
    ],
  },
  tests: {
    vitest: {
      "apps/web/src/dozo-y.test.ts": { passed: 3, failed: 1, skipped: 0 },
      "apps/web/src/x.test.ts": { passed: 4, failed: 0, skipped: 2 },
    },
    node: { "dozo/**/*.test.mjs": { passed: 2, failed: 0, skipped: 0 } },
    coverage: {
      "dozo/a.mjs": { lines: [8, 10], branches: [1, 2] },
      "apps/web/src/x.ts": { lines: [0, 10], branches: [0, 0] },
    },
  },
  bundle: { kb: 1, budgetKb: 2 },
});

const scores = (set) =>
  Object.fromEntries(Object.entries(set.results).map(([id, r]) => [id, r.score]));

test("the fork set is what dozo/NOTICE lists", () => {
  for (const f of [
    "dozo/x.sh",
    "apps/web/src/dozo-a.ts",
    "packages/db/prisma/migrations/1_dozo_plans/migration.sql",
  ]) {
    assert.ok(isFork(f), f);
  }
  for (const f of ["apps/web/src/a.ts", "scripts/dozo-x.mjs", "apps/web/src/dozo/a.ts"])
    assert.ok(!isFork(f), f);
});

test("fork sub-scores and composites", () => {
  const fork = scoreSet(measures(), SETS.fork);
  const s = scores(fork);
  assert.equal(s.types, 100);
  assert.equal(s.lint, 50);
  assert.equal(s.tests.toFixed(2), "83.33");
  assert.equal(s.lineCoverage, 80);
  assert.equal(s.branchCoverage, 50);
  assert.equal(s.security, 25); // worst advisory high: rating D
  assert.equal(s.shell, 100);
  assert.equal(s.checks, 90);
  assert.equal(s.complexity, 50); // 20 and 16 are over 15, of four functions
  assert.equal(s.functionLength, 75);
  assert.equal(s.fileLength, 50);
  assert.equal(s.duplication, 100);
  assert.equal(fork.quality.toFixed(2), "74.17");
  assert.equal(fork.readability, 76.25);
  assert.deepEqual(fork.results.complexity.raw.distribution, {
    0: 1,
    "1-5": 1,
    "6-10": 0,
    "11-15": 0,
    "16-25": 2,
    ">25": 0,
  });
  assert.deepEqual(
    fork.results.security.jobs.map((j) => [j.target, j.gain]),
    [
      ["a (high)", 12.5],
      ["b (high)", 12.5],
    ],
  );
});

test("duplication is rated by SonarQube's bands, a job by what it lifts", () => {
  const all = scoreSet(measures(), SETS.all);
  assert.equal(all.results.duplication.raw.rating, "B"); // 20 of 550 lines: 3.6 %
  assert.equal(all.results.duplication.score, 75);
  assert.equal(all.results.duplication.jobs[0].gain, 25);
  assert.equal(scores(all).types, 50);
});

test("a sub-measure with nothing in scope drops out of the composite", () => {
  const m = measures();
  m.files.shell = [];
  const fork = scoreSet(m, SETS.fork);
  assert.equal(fork.results.shell.score, null);
  assert.equal(fork.quality.toFixed(2), ((7416.6667 - 500) / 95).toFixed(2));
});
