// Offline tests of test-verdict.mjs: a skipped file turns the verdict red. Run by `gate.sh olc`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const relay = verdict("unit", { testResults: [at("packages/adapters/src/dozo-user-browser.relay.test.ts", [t("skipped")])] });
  assert.equal(relay.ok, true);
  const bad = verdict("unit", { testResults: [file("dozo-c.test.ts", [t("skipped", "later")])] });
  assert.equal(bad.ok, false);
  assert.match(bad.lines.join("\n"), /unexpected skip: .*dozo-c\.test\.ts > later/);
});

const at = (path, tests, extra) => ({ name: `/w/${path}`, status: "passed", assertionResults: tests, ...extra });
test("two files with one name in different directories: one missing is red", () => {
  const a = "apps/api/src/dozo-x.postgres.test.ts";
  const b = "packages/db/src/dozo-x.postgres.test.ts";
  const both = verdict("postgres", { testResults: [at(a, [t("passed")]), at(b, [t("passed")])] }, { zone: "UTC", expected: [a, b] });
  assert.equal(both.ok, true);
  const one = verdict("postgres", { testResults: [at(a, [t("passed")]), at("apps/api/src/dozo-x.postgres.test.ts", [t("passed")], { name: "/w/apps/api/src/dozo-x.postgres.test.ts" })] }, { zone: "UTC", expected: [a, b] });
  assert.equal(one.ok, false);
  assert.match(one.lines.join("\n"), /file did not run: packages\/db\/src\/dozo-x\.postgres\.test\.ts/);
  const lone = verdict("postgres", { testResults: [at(a, [t("passed")])] }, { zone: "UTC", expected: [a, b] });
  assert.match(lone.lines.join("\n"), /did not run: packages\/db/);
});
test("a path must match whole directories, not a suffix of one", () => {
  const exp = "packages/db/src/dozo-x.postgres.test.ts";
  const r = verdict("postgres", { testResults: [at("xpackages/db/src/dozo-x.postgres.test.ts", [t("passed")])] }, { zone: "UTC", expected: [exp] });
  assert.equal(r.ok, false);
});
test("a different number of files ran than expected is red", () => {
  const exp = "packages/db/src/dozo-x.postgres.test.ts";
  const r = verdict("postgres", { testResults: [at(exp, [t("passed")]), at("packages/db/src/dozo-extra.postgres.test.ts", [t("passed")])] }, { zone: "UTC", expected: [exp] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /2 files ran, 1 expected/);
});
test("a report without testResults is red in both modes", () => {
  assert.equal(verdict("postgres", {}, { zone: "UTC", expected: ["a/dozo-x.postgres.test.ts"] }).ok, false);
  assert.equal(verdict("unit", {}).ok, false);
});
test("unit: only the files the Postgres run covers may skip", () => {
  const skip = (path) => verdict("unit", { testResults: [at(path, [t("skipped")])] }).ok;
  assert.equal(skip("apps/api/src/dozo-a.postgres.test.ts"), true);
  assert.equal(skip("packages/db/src/sub/dozo-a.postgres.test.ts"), true);
  assert.equal(skip("infra/x/dozo-a.postgres.test.ts"), false);
  assert.equal(skip("packages/db/src/dozo-a.postgres.test.tsx"), false);
  assert.equal(skip("packages/db/src/other.postgres.test.ts"), false);
  assert.equal(skip("packages/adapters/src/dozo-user-browser.relay.test.ts"), true);
  assert.equal(skip("packages/adapters/src/xdozo-user-browser.relay.test.ts"), false);
  assert.equal(skip("packages/db/src/dozo-user-browser.relay.test.ts"), false);
});
test("the Postgres script finds the same set the unit exemption names", () => {
  const sh = readFileSync(new URL("./postgres-tests.sh", import.meta.url), "utf8");
  assert.match(sh, /find apps packages .*-name 'dozo-\*\.postgres\.test\.ts'/);
});
test("the command line: unreadable, malformed and incomplete reports exit 2, usage 64", () => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-"));
  const script = new URL("./test-verdict.mjs", import.meta.url).pathname;
  const run = (...args) => spawnSync("node", [script, ...args], { encoding: "utf8" });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "{}");
  for (const path of [join(dir, "missing.json"), bad]) {
    const r = run("postgres", path, "UTC", "a/dozo-x.postgres.test.ts");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no readable report/);
  }
  assert.equal(run("postgres", empty, "UTC", "a/dozo-x.postgres.test.ts").status, 2);
  assert.equal(run("unit", empty).status, 2);
  assert.equal(run("bogus").status, 64);
});
