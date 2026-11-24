#!/usr/bin/env node
// The verdict on a Vitest JSON report, for the two runs where a silent skip would be a false green.
//   postgres <report.json> <zone> <expected file>...   every expected dozo-*.postgres.test.ts file
//     ran, no file is empty, nothing failed, skipped or is todo, and at least one test passed.
//     The run always has its database, so a skipped test means the run did not reach it (a
//     `describe.skip` without a database, or a `beforeAll` that failed and skipped the rest).
//   unit <report.json>   the fork unit run has no database: a skipped test is expected only in a
//     *.postgres.test.ts file or the relay test (other runs cover those). Any other skip is a failure.
// Prints one line per problem and a summary; exit 0 clean, 2 not (64 usage). ANSI colour is
// stripped from the messages so the first error line of a failed file shows.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const clean = (text) => String(text ?? "").replace(ANSI, "");
const firstLines = (text, n = 6) =>
  clean(text)
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, n)
    .join("\n    ");
// Files that skip in the unit run because another run gives them what they need: every
// *.postgres.test.ts file (the Postgres run) and the relay test (dozo/desktop/tests/relay_e2e.sh).
const needsOtherRun = (file) => /\.postgres\.test\.tsx?$|dozo-user-browser\.relay\.test\.ts$/.test(file);
const isSkipped = (status) => status === "skipped" || status === "pending" || status === "todo";

/** Returns { lines, ok, summary } for a parsed Vitest JSON report. */
export function verdict(mode, report, { zone = "", expected = [] } = {}) {
  const lines = [];
  const files = report.testResults ?? [];
  const tests = files.flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ file: file.name, test })),
  );
  const count = (pick) => tests.filter(({ test }) => pick(test.status)).length;
  const passed = count((s) => s === "passed");
  const failed = count((s) => s === "failed");
  const skipped = count(isSkipped);
  const where = (name) => clean(name).replace(/^.*?((?:apps|packages|infra)\/)/, "$1");

  for (const file of files) {
    if (file.status === "failed" || (file.assertionResults ?? []).some((t) => t.status === "failed")) {
      lines.push(`file failed: ${where(file.name)}`);
      const message =
        file.message ||
        (file.assertionResults ?? []).flatMap((t) => t.failureMessages ?? []).join("\n");
      if (message) lines.push(`    ${firstLines(message)}`);
    }
  }
  if (mode === "postgres") {
    const ran = new Set(files.map((file) => basename(file.name)));
    for (const path of expected) {
      if (!ran.has(basename(path))) lines.push(`file did not run: ${path}`);
    }
    for (const file of files) {
      if ((file.assertionResults ?? []).length === 0)
        lines.push(`file ran no test: ${where(file.name)}`);
    }
    for (const { file, test } of tests) {
      if (isSkipped(test.status))
        lines.push(`skipped (${test.status}): ${where(file)} > ${test.fullName ?? test.title}`);
    }
    if (passed === 0) lines.push("no test passed");
    if (failed > 0) lines.push(`${failed} test(s) failed`);
    const label = `${zone || "run"}: ${files.length} of ${expected.length} files, ${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { lines, ok: lines.length === 0, summary: label };
  }
  for (const { file, test } of tests) {
    if (isSkipped(test.status) && !needsOtherRun(file))
      lines.push(`unexpected skip: ${where(file)} > ${test.fullName ?? test.title}`);
  }
  const postgresSkips = tests.filter(
    ({ file, test }) => isSkipped(test.status) && needsOtherRun(file),
  ).length;
  return {
    lines,
    ok: lines.length === 0,
    summary: `unit: ${passed} passed, ${postgresSkips} skipped in files another run covers (expected), ${skipped - postgresSkips} skipped elsewhere`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, path, ...rest] = process.argv.slice(2);
  if ((mode !== "postgres" && mode !== "unit") || !path || (mode === "postgres" && rest.length < 2)) {
    console.error("usage: test-verdict.mjs postgres <report.json> <zone> <expected file>... | unit <report.json>");
    process.exit(64);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.log(`[verdict] no readable report at ${path}: ${error.message}`);
    process.exit(2);
  }
  const result = verdict(mode, report, { zone: rest[0], expected: rest.slice(1) });
  for (const line of result.lines) console.log(`[verdict] ${line}`);
  console.log(`[verdict] ${result.ok ? "ok" : "FAIL"} ${result.summary}`);
  process.exit(result.ok ? 0 : 2);
}
