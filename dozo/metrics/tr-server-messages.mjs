// Counts the server's user-visible refusals that a Turkish UI cannot say in Turkish.
//
//   node dozo/metrics/tr-server-messages.mjs --root <branded staged tree> [--list]
//
// A refusal is a fixed message the API, the database layer or the computer adapters send to a
// client: `new ORPCError("CODE", { message: "..." })` in apps/api/src, and `super("CODE", "...")`
// of a ClientError (or `super("...")` of a sandbox error) in packages/db, packages/adapters and
// packages/adapter-kit. It counts as said in Turkish when the branded Turkish catalog has its exact
// text as a translated entry, or when it carries one of the plan-limit codes the clients translate.
// A message built at run time (`${...}`) is counted, and counts as not said unless it has such a
// code. Not part of `make olc` or `make qa`: run it before and after a change and compare.
// Exit codes: 0 counted; 2 the tree has no Turkish catalog; 64 usage.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
if (rootAt === -1 || !args[rootAt + 1]) {
  console.error("usage: tr-server-messages.mjs --root <tree> [--list]");
  process.exit(64);
}
const root = path.resolve(args[rootAt + 1]);
const list = args.includes("--list");

// The codes `@rakazo/contracts` PLAN_LIMIT_CODES gives the server's refusals; clients word them.
const TRANSLATED_CODES = new Set([
  "shared_space_full",
  "COMPUTERS_BUSY",
  "computer_limit_reached",
  "space_limit_reached",
  "plan_not_offered",
  "PLAN_LIMIT_CODES.sharedSpaceFull",
  "PLAN_LIMIT_CODES.computerLimit",
  "PLAN_LIMIT_CODES.spaceLimit",
  "PLAN_LIMIT_CODES.planNotOffered",
  "COMPUTERS_BUSY_CODE",
]);

function sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) => !/\.(test|test-support|spec)\.ts$/.test(file) && !file.includes("node_modules"),
    );
}

/** A JavaScript string or template literal's text; null for anything else. */
function literal(source) {
  const quote = source[0];
  if (quote !== '"' && quote !== "`") return null;
  const end = source.indexOf(quote, 1);
  return end === -1 ? null : source.slice(1, end).replaceAll('\\"', '"');
}

/** Constant names the scanned files give a string (`const NAME = "..."`), for messages by name. */
function constants(files) {
  const named = new Map();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /(?:export )?const ([A-Z][A-Z0-9_]+)\s*=\s*\n?\s*("[^"\n]*")/g,
    ))
      named.set(match[1], match[2].slice(1, -1));
  }
  return named;
}

const scanned = [
  ...sourceFiles("apps/api/src"),
  ...sourceFiles("packages/db/src"),
  ...sourceFiles("packages/adapters/src"),
  ...sourceFiles("packages/adapter-kit/src"),
];
const named = constants([
  ...scanned,
  ...sourceFiles("packages/contracts/src"),
  ...sourceFiles("packages/core/src"),
]);

/** Every refusal once, by text, with whether a translated code carries it. */
const refusals = new Map();
function add(text, code) {
  if (!text) return;
  const name = code?.trim().replace(/^"(.*)"$/, "$1");
  const coded = refusals.get(text) || (name !== undefined && TRANSLATED_CODES.has(name));
  refusals.set(text, coded);
}
function message(expression) {
  const trimmed = expression.trim();
  return literal(trimmed) ?? named.get(trimmed) ?? null;
}

for (const file of scanned) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /new ORPCError\(\s*"[A-Z_]+",\s*\{\s*message:\s*("[^"\n]*"|`[^`]*`|[A-Z][A-Z0-9_]+)/g,
  ))
    add(message(match[1]));
  for (const match of source.matchAll(
    /super\(\s*"[A-Z_]+",\s*("[^"\n]*"|`[^`]*`|[A-Z][A-Z0-9_]+)\s*(?:,\s*([^)]+))?\)/g,
  ))
    add(message(match[1]), match[2]);
  if (file.endsWith("sandbox-errors.ts") || file.endsWith("computer-lifecycle.ts"))
    for (const match of source.matchAll(/super\(\s*("[^"\n]*"|[A-Z][A-Z0-9_]+)\s*[,)]/g)) {
      const text = message(match[1]);
      // A ClientError's first argument is its kind, not its message.
      if (text && !/^[A-Z_]+$/.test(text)) add(text);
    }
}

let catalog;
try {
  catalog = readFileSync(path.join(root, "packages/i18n/locales/tr/messages.po"), "utf8");
} catch {
  console.error(`no Turkish catalog under ${root}`);
  process.exit(2);
}
/** Each msgid with a non-empty msgstr. PO strings may continue over several quoted lines. */
const translated = new Set();
for (const entry of catalog.split(/\n\s*\n/)) {
  const read = (key) => {
    const match = entry.match(new RegExp(`^${key} ((?:"(?:[^"\\\\]|\\\\.)*"\\n?)+)`, "m"));
    if (!match) return "";
    return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((part) => part[1])
      .join("")
      .replaceAll('\\"', '"');
  };
  const id = read("msgid");
  if (id && read("msgstr")) translated.add(id);
}

const missing = [...refusals]
  .filter(([text, coded]) => !coded && (text.includes("${") || !translated.has(text)))
  .map(([text]) => text)
  .sort();
console.log(
  `TR-SERVER: ${refusals.size} refusals, ${refusals.size - missing.length} said in Turkish, ${missing.length} not`,
);
if (list) for (const text of missing) console.log(`  ${text}`);
