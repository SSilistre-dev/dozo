// Offline tests of test-verdict.mjs: a skipped file turns the verdict red. Run by `gate.sh olc`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "./test-verdict.mjs";

const t = (status, title = "t") => ({ status, title, fullName: title, failureMessages: [] });
const file = (name, tests, extra = {}) => ({
  name: `/w/packages/db/src/${name}`,
  status: "passed",
  assertionResults: tests,
  ...extra,
});
const A = "packages/db/src/dozo-a.postgres.test.ts";
const B = "packages/db/src/dozo-b.postgres.test.ts";
const run = (files, expected = [A, B]) =>
  verdict("postgres", { testResults: files }, { zone: "UTC", expected });
const green = () => [file("dozo-a.postgres.test.ts", [t("passed")]), file("dozo-b.postgres.test.ts", [t("passed")])];

test("every expected file ran and passed is green", () => {
  const r = run(green());
  assert.equal(r.ok, true);
  assert.match(r.summary, /2 of 2 files, 2 passed, 0 failed, 0 skipped/);
});
test("a skipped test is red, named with its file", () => {
  const r = run([file("dozo-a.postgres.test.ts", [t("passed")]), file("dozo-b.postgres.test.ts", [t("skipped", "does x")])]);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /skipped \(skipped\): packages\/db\/src\/dozo-b\.postgres\.test\.ts > does x/);
});
test("pending and todo count as skipped", () => {
  assert.equal(run([...green().slice(0, 1), file("dozo-b.postgres.test.ts", [t("pending"), t("todo")])]).ok, false);
});
test("a file that did not run is red", () => {
  const r = run(green().slice(0, 1));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /file did not run: packages\/db\/src\/dozo-b\.postgres\.test\.ts/);
});
test("a file with no tests is red", () => {
  assert.equal(run([green()[0], file("dozo-b.postgres.test.ts", [])]).ok, false);
});
test("zero tests passed is red", () => {
  assert.equal(run([], []).ok, false);
});
test("a failed file shows its error without colour codes", () => {
  const failing = file("dozo-b.postgres.test.ts", [t("skipped")], {
    status: "failed",
    message: "\u001b[31mError: password authentication failed\u001b[39m",
  });
  const r = run([green()[0], failing]);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /Error: password authentication failed/);
  assert.doesNotMatch(r.lines.join("\n"), /\u001b/);
});
test("unit: a skip in a Postgres file is expected, any other is not", () => {
  const ok = verdict("unit", { testResults: [file("dozo-a.postgres.test.ts", [t("skipped")]), file("dozo-c.test.ts", [t("passed")])] });
  assert.equal(ok.ok, true);
  const bad = verdict("unit", { testResults: [file("dozo-c.test.ts", [t("skipped", "later")])] });
  assert.equal(bad.ok, false);
  assert.match(bad.lines.join("\n"), /unexpected skip: .*dozo-c\.test\.ts > later/);
});
