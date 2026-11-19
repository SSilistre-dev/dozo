// Measurements that run code: unit tests with coverage, `pnpm checks`, the dependency audit and the
// web startup bundle. Upstream's tests run on the unbranded tree (they assert upstream's wording);
// the fork's own dozo-* tests on the branded tree, as `gate.sh unit` runs them.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { must, SRC, STAGE, tapSummary, WORKERS } from "./run.mjs";

const NO_TESTS = ["--coverage.exclude=**/*.test.*", "--coverage.exclude=**/*.test-support.*"];
// Upstream's source next to its Vitest tests (the `include` list of vitest.config.ts).
const UPSTREAM_SOURCE = [
  "apps/*/src/**/*.{ts,tsx}",
  "apps/mobile/lib/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "infra/**/src/**/*.ts",
];
const FORK_SOURCE = [
  "apps/**/dozo-*.{ts,tsx}",
  "packages/**/dozo-*.{ts,tsx}",
  "infra/**/dozo-*.ts",
];

/** One Vitest run with V8 coverage: test results and line and branch coverage, per file. */
async function vitest(root, name, include, args) {
  const json = `/tmp/${name}.json`;
  const covDir = `/tmp/${name}-coverage`;
  await must(
    path.join(root, "node_modules/.bin/vitest"),
    [
      "run",
      `--maxWorkers=${WORKERS}`,
      "--reporter=json",
      `--outputFile=${json}`,
      "--coverage",
      "--coverage.reporter=json-summary",
      "--coverage.reportOnFailure", // a failed test must not hide the coverage
      `--coverage.reportsDirectory=${covDir}`,
      ...include.map((glob) => `--coverage.include=${glob}`),
      ...NO_TESTS,
      "--coverage.exclude=**/generated/**",
      "--coverage.exclude=**/*.d.ts",
      ...args,
    ],
    { cwd: root },
    [0, 1],
  );
  if (!existsSync(json)) throw new Error(`vitest (${name}) wrote no report`);
  return {
    tests: testsPerFile(root, json),
    coverage: coveragePerFile(root, `${covDir}/coverage-summary.json`),
  };
}

function testsPerFile(root, json) {
  const tests = {};
  for (const file of JSON.parse(readFileSync(json, "utf8")).testResults) {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const a of file.assertionResults) {
      counts[a.status === "passed" || a.status === "failed" ? a.status : "skipped"]++;
    }
    // A file that fails before its tests run (an import error) counts as one failed test.
    if (file.status === "failed" && counts.failed === 0) counts.failed = 1;
    tests[path.relative(root, file.name)] = counts;
  }
  return tests;
}

function coveragePerFile(root, summary) {
  const coverage = {};
  for (const [file, c] of Object.entries(JSON.parse(readFileSync(summary, "utf8")))) {
    if (file === "total") continue;
    coverage[path.relative(root, file)] = {
      lines: [c.lines.covered, c.lines.total],
      branches: [c.branches.covered, c.branches.total],
    };
  }
  return coverage;
}

/** Node's test runner with coverage (the fork's dozo/ tests): counts and lcov per file. */
async function nodeTests(files, coverage) {
  const args = [
    "--test",
    `--test-concurrency=${WORKERS}`,
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
  ];
  if (coverage) {
    args.push(
      "--experimental-test-coverage",
      "--test-reporter=lcov",
      "--test-reporter-destination=/tmp/node.lcov",
    );
  }
  const { stdout } = await must("node", [...args, ...files], {}, [0, 1]);
  return { summary: tapSummary(stdout), coverage: coverage ? lcov("/tmp/node.lcov") : {} };
}

function lcov(file) {
  const coverage = {};
  for (const record of readFileSync(file, "utf8").split("end_of_record")) {
    const field = (key) => Number(record.match(new RegExp(`^${key}:(\\d+)$`, "m"))?.[1] ?? 0);
    const source = record.match(/^SF:(.+)$/m)?.[1];
    if (!source) continue;
    coverage[path.relative(SRC, source)] = {
      lines: [field("LH"), field("LF")],
      branches: [field("BRH"), field("BRF")],
    };
  }
  return coverage;
}

/** Every test run: upstream's suite (`pnpm test`), the fork's Vitest files and its node tests. */
export async function tests(files) {
  const forkVitest = files.filter((f) =>
    /^(apps|packages|infra)\/.*\/dozo-[^/]*\.test\.tsx?$/.test(f),
  );
  const forkNode = files.filter((f) => f.startsWith("dozo/") && f.endsWith(".test.mjs"));
  const all = await vitest(SRC, "vitest-all", UPSTREAM_SOURCE, []);
  const fork = await vitest(STAGE, "vitest-fork", FORK_SOURCE, forkVitest);
  const node = await nodeTests(forkNode, true);
  const scripts = await nodeTests(
    ["scripts/pnpm.test.mjs", "scripts/setup-worktree.test.mjs"],
    false,
  );
  return {
    // Fork test files run on the branded tree only; their unbranded results are dropped.
    vitest: { ...dropFork(all.tests), ...fork.tests },
    coverage: { ...dropFork(all.coverage), ...fork.coverage, ...node.coverage },
    node: { "dozo/**/*.test.mjs": node.summary, "scripts/*.test.mjs": scripts.summary },
  };
}

const dropFork = (map) =>
  Object.fromEntries(Object.entries(map).filter(([file]) => !/\/dozo-[^/]*$/.test(file)));

/** `pnpm checks`: the repository's convention checks. */
export async function checks(files) {
  const tests = files.filter((f) => /^scripts\/checks\/[^/]+\.test\.mjs$/.test(f));
  const { stdout } = await must("node", ["--test", "--test-reporter=tap", ...tests], {}, [0, 1]);
  return tapSummary(stdout);
}

/** `pnpm audit` over the whole lockfile: vulnerable packages by severity. */
export async function audit() {
  const { stdout } = await must("pnpm", ["audit", "--json"], {}, [0, 1]);
  const report = JSON.parse(stdout);
  const advisories = Object.values(report.advisories).map((a) => ({
    module: a.module_name,
    severity: a.severity,
    title: a.title,
  }));
  return { counts: report.metadata.vulnerabilities, advisories };
}

/** The web startup bundle, built from the branded tree and measured by scripts/checks/bundle-size.mjs. */
export async function bundle() {
  await must(
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=@rakazo/web", "--output-logs=errors-only"],
    { cwd: STAGE },
  );
  const { checkBundleSizes } = await import(
    pathToFileURL(path.join(STAGE, "scripts/checks/bundle-size.mjs")).href
  );
  const budgets = JSON.parse(
    readFileSync(path.join(STAGE, "scripts/checks/bundle-size.budgets.json"), "utf8"),
  );
  const { passed, failures } = checkBundleSizes(STAGE, budgets);
  const text = [...passed, ...failures].find((line) => /web-startup/.test(line)) ?? "";
  const kb = Number(
    text
      .match(/web-startup: ([\d,.]+) kB|Measured ([\d,.]+) kB/)
      ?.slice(1)
      .find(Boolean)
      ?.replace(/,/g, ""),
  );
  if (!Number.isFinite(kb)) throw new Error(`bundle-size.mjs did not measure web-startup: ${text}`);
  return { kb, budgetKb: budgets["web-startup"] };
}
