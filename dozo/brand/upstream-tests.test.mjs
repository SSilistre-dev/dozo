import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compare, filesToCompare, main, parseKnown, redTests } from "./upstream-tests.mjs";

// The comparison behind dozo/docker/upstream-tests.sh, and the shipped list.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const line = (...fields) => fields.join("\t");
const reason = "the fork's sign-in screen";

/** A Vitest JSON report: `{ file: { test: "passed" | "failed" } }`; `null` is a file that failed to load. */
function vitest(results, root = "/w/") {
  return {
    testResults: Object.entries(results).map(([file, tests]) => ({
      name: `${root}${file}`,
      status: tests === null || Object.values(tests).includes("failed") ? "failed" : "passed",
      assertionResults: Object.entries(tests ?? {}).map(([fullName, status]) => ({
        fullName,
        status,
      })),
    })),
  };
}

function files(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-tests-"));
  for (const [name, value] of Object.entries(contents))
    fs.writeFileSync(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  return (name) => path.join(dir, name);
}

describe("the list", () => {
  it("reads entries and skips comments and blank lines", () => {
    const known = parseKnown(`# note\n\n${line("a.test.ts", "says hi", "a", reason)}\n`);
    assert.deepEqual([...known.keys()], [line("a.test.ts", "says hi")]);
    assert.equal(known.get(line("a.test.ts", "says hi")).kind, "a");
  });

  it("refuses a malformed line, naming it", () => {
    for (const [text, pattern] of [
      [line("a.test.ts", "x", "a"), /:1: needs 4 tab-separated fields/],
      [line("", "x", "a", reason), /:1: empty file or test/],
      [line("a.test.ts", "x", "d", reason), /:1: class must be a, b or c/],
      [line("a.test.ts", "x", "b", "short"), /:1: the reason is missing/],
      [
        `#\n${line("a.test.ts", "x", "c", reason)}\n${line("a.test.ts", "x", "c", reason)}`,
        /:3: listed twice/,
      ],
    ])
      assert.throws(() => parseKnown(text), pattern);
  });
});

describe("a Vitest report", () => {
  it("lists failed tests and files that failed with none, relative to the root", () => {
    const red = redTests(
      vitest({ "a.test.ts": { ok: "passed", bad: "failed" }, "b.test.ts": null, "c.test.ts": {} }),
    );
    assert.deepEqual([...red].sort(), [line("a.test.ts", "bad"), line("b.test.ts", "<file>")]);
    assert.deepEqual(
      [...redTests(vitest({ "x.test.ts": { t: "failed" } }, "/other/"))],
      [line("/other/x.test.ts", "t")],
    );
  });

  it("refuses something else", () => {
    assert.throws(() => redTests({}), /not a Vitest JSON report/);
  });
});

describe("the comparison", () => {
  const known = parseKnown(
    [line("a.test.ts", "listed", "b", reason), line("b.test.ts", "flaky listed", "a", reason)].join(
      "\n",
    ),
  );
  const set = (...entries) => new Set(entries.map((entry) => line(...entry)));

  it("compares the files with red on the branded tree and the listed ones", () => {
    assert.deepEqual(filesToCompare(known, set(["c.test.ts", "x"], ["a.test.ts", "y"])), [
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
    ]);
  });

  it("passes when the red only on the branded tree is what the list holds", () => {
    const result = compare({
      known,
      branded: set(["a.test.ts", "listed"], ["b.test.ts", "flaky listed"], ["e.test.ts", "env"]),
      pristine: set(["e.test.ts", "env"]),
    });
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.gone, []);
    assert.equal(result.forkRed.size, 2);
  });

  it("finds new red and listed tests that are green again or red unbranded too", () => {
    const result = compare({
      known,
      branded: set(["a.test.ts", "listed"], ["c.test.ts", "new"]),
      pristine: set(["a.test.ts", "listed"]),
    });
    assert.deepEqual(result.added, [line("c.test.ts", "new")]);
    assert.deepEqual(result.gone, [
      { entry: line("a.test.ts", "listed"), alsoUnbranded: true },
      { entry: line("b.test.ts", "flaky listed"), alsoUnbranded: false },
    ]);
  });

  it("lets the recheck clear a flaky finding either way", () => {
    const result = compare({
      known,
      branded: set(["a.test.ts", "listed"], ["c.test.ts", "flaky new"]),
      pristine: set(),
      recheck: set(["b.test.ts", "flaky listed"]),
    });
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.gone, []);
  });
});

describe("the command line", () => {
  const listed = line("a.test.ts", "listed", "b", reason);
  const at = files({
    "known.tsv": listed,
    "bad.tsv": "a.test.ts\tx",
    "branded.json": vitest({ "a.test.ts": { listed: "failed" }, "c.test.ts": { new: "failed" } }),
    "clean.json": vitest({ "a.test.ts": { listed: "failed" } }),
    "pristine.json": vitest({}),
    "recheck.json": vitest({ "c.test.ts": { new: "passed" } }),
    "broken.json": "{",
  });
  const args = (...rest) => ["--known", at("known.tsv"), ...rest];

  it("prints the files to compare", () => {
    assert.deepEqual(main(["files", ...args("--branded", at("branded.json"))]), {
      code: 0,
      lines: ["a.test.ts", "c.test.ts"],
    });
  });

  it("prints the files of the findings", () => {
    const run = main([
      "suspects",
      ...args("--branded", at("branded.json"), "--pristine", at("pristine.json")),
    ]);
    assert.deepEqual(run, { code: 0, lines: ["c.test.ts"] });
    const green = main([
      "suspects",
      ...args("--branded", at("pristine.json"), "--pristine", at("pristine.json")),
    ]);
    assert.deepEqual(green, { code: 0, lines: ["a.test.ts"] });
  });

  it("fails on a finding and names it, and passes once the recheck clears it", () => {
    const failed = main([
      "verdict",
      ...args("--branded", at("branded.json"), "--pristine", at("pristine.json")),
    ]);
    assert.equal(failed.code, 2);
    assert.match(failed.lines[0], /new red .*c\.test\.ts\tnew/);
    assert.match(
      failed.lines.at(-1),
      /^UPSTREAM: FAIL \(1 new red, 0 listed now green; 1 listed, 2 red/,
    );
    const passed = main([
      "verdict",
      ...args("--branded", at("branded.json"), "--pristine", at("pristine.json")),
      "--recheck",
      at("recheck.json"),
    ]);
    assert.deepEqual(passed, {
      code: 0,
      lines: ["UPSTREAM: PASS (1 listed, 2 red only on the branded tree)"],
    });
  });

  it("says when a listed test is red unbranded too", () => {
    const run = main([
      "verdict",
      ...args("--branded", at("clean.json"), "--pristine", at("clean.json")),
    ]);
    assert.equal(run.code, 2);
    assert.match(run.lines[0], /a\.test\.ts\tlisted \(red on the unbranded tree too\)/);
  });

  it("fails on a usage error or an unreadable input, without a stack trace", () => {
    for (const [argv, pattern] of [
      [[], /usage: upstream-tests\.mjs/],
      [["files", "--known", at("known.tsv")], /files needs --known and --branded/],
      [
        ["verdict", ...args("--branded", at("branded.json"))],
        /verdict needs --known, --branded and --pristine/,
      ],
      [["files", "--known"], /--known needs a value/],
      [["files", "known"], /unexpected known/],
      [["files", "--known", "x", "--known", "y"], /--known given twice/],
      [
        ["files", "--known", at("missing.tsv"), "--branded", at("branded.json")],
        /cannot read .*missing\.tsv/,
      ],
      [
        ["files", "--known", at("known.tsv"), "--branded", at("broken.json")],
        /cannot read .*broken\.json/,
      ],
      [
        ["files", "--known", at("bad.tsv"), "--branded", at("branded.json")],
        /needs 4 tab-separated fields/,
      ],
    ]) {
      const run = main(argv);
      assert.equal(run.code, 2, argv.join(" "));
      assert.match(run.lines[0], pattern);
    }
  });

  it("runs as a script with the same answer and exit code", () => {
    const script = path.join(HERE, "upstream-tests.mjs");
    const run = spawnSync(
      process.execPath,
      [script, "files", ...args("--branded", at("branded.json"))],
      {
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "a.test.ts\nc.test.ts\n");
    const failed = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(failed.status, 2);
    assert.match(failed.stdout, /^UPSTREAM: FAIL \(usage/);
  });
});

describe("the shipped list", () => {
  it("is well formed", () => {
    parseKnown(fs.readFileSync(path.join(HERE, "upstream-tests-known.tsv"), "utf8"));
  });
});
