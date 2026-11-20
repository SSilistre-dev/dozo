#!/usr/bin/env node
/**
 * Upstream's tests on the branded tree: which of them the brand step turns red, against the
 * reviewed list of the ones it may (`upstream-tests-known.tsv`). Run by
 * `dozo/docker/upstream-tests.sh`; see `dozo/docker/README.md`, Upstream tests.
 *
 *   node dozo/brand/upstream-tests.mjs files --known <tsv> --branded <json>
 *   node dozo/brand/upstream-tests.mjs suspects|verdict --known <tsv> --branded <json>
 *        --pristine <json> [--recheck <json>]
 *
 * The JSON files are Vitest's JSON reports. A test is red when it failed; a file that failed to
 * load with no test reported is one red entry, `<file>`. Red only on the branded tree means red
 * there and not in the unbranded run (which covers every file `files` printed). `--recheck` is a
 * second branded run of the files with a finding: a new red must be red again, and a listed test
 * must be green again, so a flaky test fails neither way.
 *
 * `files` prints, one per line, the test files to run on the unbranded tree: those with a red
 * test on the branded one and those the list names. `suspects` prints the files of the findings,
 * for the recheck. `verdict` prints the findings and a last line
 * `UPSTREAM: PASS (...)` or `UPSTREAM: FAIL (...)`; exit 0, or 2 for a finding, a malformed list
 * or report, or a usage error.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const CLASSES = {
  a: "brand text or a renamed identifier",
  b: "a deliberate fork difference",
  c: "a test fixture the fork's code needs and the test lacks",
};
const FILE = "<file>";

const key = (file, test) => `${file}\t${test}`;

/** The reviewed list: `file<TAB>test<TAB>class<TAB>reason` per line, `#` comments, blank lines. */
export function parseKnown(text) {
  const known = new Map();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    const where = `upstream-tests-known.tsv:${index + 1}`;
    const fields = line.split("\t");
    if (fields.length !== 4) throw new Error(`${where}: needs 4 tab-separated fields`);
    const [file, test, kind, reason] = fields;
    if (!file || !test) throw new Error(`${where}: empty file or test`);
    if (!Object.hasOwn(CLASSES, kind)) throw new Error(`${where}: class must be a, b or c`);
    if (reason.trim().length < 10) throw new Error(`${where}: the reason is missing`);
    if (known.has(key(file, test))) throw new Error(`${where}: listed twice`);
    known.set(key(file, test), { file, test, kind, reason });
  });
  return known;
}

/** The red tests of a Vitest JSON report, as `file<TAB>test` keys relative to `root`. */
export function redTests(report, root = "/w/") {
  if (!Array.isArray(report?.testResults)) throw new Error("not a Vitest JSON report");
  const red = new Set();
  for (const result of report.testResults) {
    const file = result.name.startsWith(root) ? result.name.slice(root.length) : result.name;
    const failed = result.assertionResults.filter((test) => test.status === "failed");
    for (const test of failed) red.add(key(file, test.fullName));
    if (result.status === "failed" && failed.length === 0) red.add(key(file, FILE));
  }
  return red;
}

const fileOf = (entry) => entry.split("\t")[0];

/** The files to run on the unbranded tree. */
export function filesToCompare(known, branded) {
  return [
    ...new Set([...branded].map(fileOf).concat([...known.values()].map((k) => k.file))),
  ].sort();
}

/** New red tests and listed tests that are no longer red only on the branded tree. */
export function compare({ known, branded, pristine, recheck }) {
  const forkRed = new Set([...branded].filter((entry) => !pristine.has(entry)));
  const added = [...forkRed].filter(
    (entry) => !known.has(entry) && (!recheck || recheck.has(entry)),
  );
  const gone = [...known.keys()]
    .filter((entry) => !forkRed.has(entry) && !recheck?.has(entry))
    .map((entry) => ({ entry, alsoUnbranded: pristine.has(entry) }));
  return {
    added: added.sort(),
    gone: gone.sort((x, y) => x.entry.localeCompare(y.entry)),
    forkRed,
  };
}

function report({ added, gone, forkRed }, known) {
  const lines = [];
  const show = (items, label) =>
    items.slice(0, 50).forEach((item) => lines.push(`[upstream] ${label}: ${item}`));
  show(added, "new red (fix it, or list it with its class and reason)");
  show(
    gone.map(({ entry, alsoUnbranded }) =>
      alsoUnbranded ? `${entry} (red on the unbranded tree too)` : entry,
    ),
    "listed but not red only on the branded tree (remove it from the list)",
  );
  const total = `${known.size} listed, ${forkRed.size} red only on the branded tree`;
  if (added.length || gone.length)
    lines.push(
      `UPSTREAM: FAIL (${added.length} new red, ${gone.length} listed now green; ${total})`,
    );
  else lines.push(`UPSTREAM: PASS (${total})`);
  return { lines, ok: added.length === 0 && gone.length === 0 };
}

function options(argv, names) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2);
    if (!argv[i]?.startsWith("--") || !names.includes(name))
      throw new Error(`unexpected ${argv[i]}`);
    if (Object.hasOwn(out, name)) throw new Error(`${argv[i]} given twice`);
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    out[name] = argv[i + 1];
  }
  return out;
}

function read(file, parse = (text) => text) {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}
const readJson = (file) => read(file, JSON.parse);

/** The command line; returns the exit code and the lines to print. */
export function main(argv) {
  try {
    const [command, ...rest] = argv;
    if (command === "files") {
      const o = options(rest, ["known", "branded"]);
      if (!o.known || !o.branded) throw new Error("files needs --known and --branded");
      const known = parseKnown(read(o.known));
      return { code: 0, lines: filesToCompare(known, redTests(readJson(o.branded))) };
    }
    if (command === "suspects" || command === "verdict") {
      const o = options(rest, ["known", "branded", "pristine", "recheck"]);
      if (!o.known || !o.branded || !o.pristine)
        throw new Error(`${command} needs --known, --branded and --pristine`);
      const known = parseKnown(read(o.known));
      const result = compare({
        known,
        branded: redTests(readJson(o.branded)),
        pristine: redTests(readJson(o.pristine)),
        recheck: o.recheck ? redTests(readJson(o.recheck)) : undefined,
      });
      if (command === "suspects") {
        const entries = result.added.concat(result.gone.map((item) => item.entry));
        return { code: 0, lines: [...new Set(entries.map(fileOf))].sort() };
      }
      const { lines, ok } = report(result, known);
      return { code: ok ? 0 : 2, lines };
    }
    throw new Error("usage: upstream-tests.mjs files|suspects|verdict --known <tsv> ...");
  } catch (error) {
    // A malformed list or report, or a usage error: a message and exit 2, not a stack trace.
    return { code: 2, lines: [`UPSTREAM: FAIL (${error.message})`] };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
