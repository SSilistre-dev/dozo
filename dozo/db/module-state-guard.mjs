#!/usr/bin/env node
// Holds the fast gate until someone has read every module-level mutable state in the fork's server
// code. One process serves many people at once, so a top-level Map, Set, cache or `let` whose key is
// not scoped by user, space, bot, thread or run is where one person's data could reach another.
// Every hit is listed once in dozo/db/module-state-reviewed.tsv with its key scope; a new one fails.
//
// Scope of the scan: the fork's own files (`dozo-*.ts|tsx|mts`) under `apps/api`, `apps/worker`
// and `packages/*`, except the pure client packages `packages/ui-web` and `packages/chat-ui`, and
// `packages/testkit` (test support). Tests (`*.test|spec.*`), `*.test-support.*`, `*.d.ts`,
// node_modules, generated, dist, e2e and .turbo are skipped. The web, desktop and mobile apps run
// per person on one device and are not scanned.
// Rule: a line at zero indentation (so not inside a function or class body) that is
//   - `let` or `var` (exported or not), or
//   - `const x = new Map|Set|WeakMap|WeakSet|<Capitalised>(...)`, other than constructors of
//     immutable values (RegExp, URL, URLSearchParams, TextEncoder, TextDecoder, Date, *Error), or
//   - `const x = {}`, `[]` or `Object.create(...)`, an empty container that is filled later.
// Also flagged: a line at exactly two spaces of indentation (the direct body of a top-level
// function, which lives as long as the process when a factory runs once) that is `let`, `var` or
// `const x = new Map|Set|WeakMap|WeakSet(`. A plain per-call local gets scope `local`.
// A declaration whose `=` ends the line is read together with the next line. False positives are
// preferred to misses. Out of scope: state nested deeper than that (inside inner functions, blocks
// or classes), and a non-empty `const` object that is mutated elsewhere in its file.
// Usage: node dozo/db/module-state-guard.mjs [--root=DIR] [--write]. Exit 0 ok, 2 an unreviewed hit
// or a stale reviewed row, 64 usage. --write keeps the scope and note of rows that still match, and
// writes `TODO` for new hits (which then fail until a person fills them in).
// Reviewed rows: dozo/db/module-state-reviewed.tsv (file<TAB>trimmed line<TAB>scope<TAB>note).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEWED = "dozo/db/module-state-reviewed.tsv";
export const SCOPES = [
  "user",
  "space",
  "bot",
  "thread",
  "run",
  "request",
  "token",
  "device",
  "global-safe",
  "local",
];
const ROOTS = ["apps/api", "apps/worker", "packages"];
const SKIPPED_DIRS = [
  "node_modules",
  "generated",
  "dist",
  "e2e",
  ".turbo",
  "ui-web",
  "chat-ui",
  "testkit",
];
const MUTABLE = /^(?:export\s+)?(?:let|var)\s/;
const CONTAINER =
  /^(?:export\s+)?const\s+[\w$]+[^=]*=\s*(?:new\s+(?!(?:RegExp|URL|URLSearchParams|TextEncoder|TextDecoder|Date|\w*Error)\b)[A-Z][\w$.]*\s*[<(]|\{\s*\}|\[\s*\]|Object\.create\()/;

const BODY_STATE =
  /^(?:(?:let|var)\s|const\s+[\w$]+[^=]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*[<(])/;

function sources(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) walk(path);
      } else if (
        /^dozo-.*\.(ts|tsx|mts)$/.test(entry.name) &&
        !/\.(test|spec|test-support)\.(ts|tsx|mts)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        found.push(path);
      }
    }
  };
  for (const top of ROOTS) walk(join(root, top));
  return found.sort();
}

/** Every module-level mutable declaration, as `file\ttrimmed line`. */
export function moduleState(root) {
  const hits = [];
  for (const path of sources(root)) {
    const file = relative(root, path);
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line === "") return;
      if (/^ {2}\S/.test(line)) {
        let body = line.trim();
        if (/=\s*$/.test(body)) body = `${body} ${(lines[index + 1] ?? "").trim()}`;
        if (BODY_STATE.test(body)) hits.push(`${file}\t${line.trim()}`);
        return;
      }
      if (/^\s/.test(line)) return;
      let text = line.trim();
      if (MUTABLE.test(text)) {
        hits.push(`${file}\t${text}`);
        return;
      }
      if (/=\s*$/.test(text)) text = `${text} ${(lines[index + 1] ?? "").trim()}`;
      if (CONTAINER.test(text)) hits.push(`${file}\t${line.trim()}`);
    });
  }
  return hits;
}

function parseReviewed(text) {
  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [file, code, scope = "", note = ""] = line.split("\t");
      return { key: `${file}\t${code}`, scope, note };
    });
}

/** Hits beyond the reviewed rows (a row covers one occurrence), rows with no hit left, and bad scopes. */
export function check(root, reviewedText) {
  const rows = parseReviewed(reviewedText);
  const left = new Map();
  for (const row of rows) left.set(row.key, (left.get(row.key) ?? 0) + 1);
  const extra = [];
  for (const hit of moduleState(root)) {
    const count = left.get(hit) ?? 0;
    if (count > 0) left.set(hit, count - 1);
    else extra.push(hit);
  }
  const stale = [...left].flatMap(([key, count]) => Array(count).fill(key));
  const badScope = rows.filter((row) => !SCOPES.includes(row.scope)).map((row) => row.key);
  return { extra, stale, badScope };
}

const HEADER = [
  "# Module-level mutable state in the fork's server code, each read for its key scope",
  "# (dozo/db/module-state-guard.mjs). Columns: file, line, scope, note. Scope is one of",
  `# ${SCOPES.join(", ")}.`,
];

export function main(argv, out = console) {
  let root = ".";
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else {
      out.error("usage: module-state-guard.mjs [--root=DIR] [--write]");
      return 64;
    }
  }
  let reviewedText = "";
  try {
    reviewedText = readFileSync(join(root, REVIEWED), "utf8");
  } catch {
    if (!write) {
      out.error(`module state guard FAILED: ${REVIEWED} is missing`);
      return 2;
    }
  }
  if (write) {
    const known = new Map(parseReviewed(reviewedText).map((row) => [row.key, row]));
    const rows = moduleState(root).map((hit) => {
      const row = known.get(hit);
      return `${hit}\t${row?.scope || "TODO"}\t${row?.note || "TODO"}`;
    });
    writeFileSync(join(root, REVIEWED), `${[...HEADER, ...rows].join("\n")}\n`);
    out.log(`module state guard: wrote ${REVIEWED}`);
    return 0;
  }
  const { extra, stale, badScope } = check(root, reviewedText);
  if (extra.length + stale.length + badScope.length === 0) {
    out.log("module state guard ok: every module-level mutable state in server code is reviewed");
    return 0;
  }
  const show = (key) => `  ${key.replace("\t", ": ")}`;
  out.error(
    [
      "module state guard FAILED:",
      ...(extra.length ? ["unreviewed module-level state:", ...extra.map(show)] : []),
      ...(stale.length ? ["reviewed rows that match no line any more:", ...stale.map(show)] : []),
      ...(badScope.length ? ["rows without a valid scope:", ...badScope.map(show)] : []),
      "Read each one: its key must be scoped by user, space, bot, thread or run (or hold only",
      "constant, public or per-IP/token data). Add a row to dozo/db/module-state-reviewed.tsv",
      "(file, line, scope, note), or run this with --write and fill in the TODO rows.",
    ].join("\n"),
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
