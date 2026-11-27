#!/usr/bin/env node
/**
 * Turkish coverage: no message the fork added is still English in the Turkish catalog, and every
 * message upstream added and nobody has translated yet is listed.
 *
 *   node dozo/brand/catalog-turkish.mjs --root <branded tree after `lingui extract`> [--upstream-files <list>]
 *
 * `catalog-parity.mjs` only holds the 16 catalogs to the same ids, so a string that extraction
 * writes into Turkish with an empty or English line passes it. This reads the Turkish catalog after
 * extraction and finds every live entry whose translation is empty or the English source, unless
 * the id is in `catalog-turkish-same.json`: the words and technical terms Turkish writes as English
 * does (units, protocol names, URLs).
 *
 * Whose entry it is decides what happens. An entry is upstream's when every source file it names is
 * in `--upstream-files` (the file names of the pristine upstream tree, one per line) and no brand
 * rule wrote its text. Upstream adds text almost every day, so those entries never fail: they are
 * printed as `pending: "<id>"` and counted, and the sync pull request queue reports them. Anything
 * else, including every entry when there is no list, is the fork's: it fails.
 *
 * Prints `TURKISH: PASS (...)` and exits 0, or the fork's ids and `TURKISH: FAIL (...)` and exits 2.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CATALOG = path.join("packages", "i18n", "locales", "tr", "messages.po");
const SAME_AS_ENGLISH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "catalog-turkish-same.json",
);
const BRAND = path.join(path.dirname(fileURLToPath(import.meta.url)), "brand.json");
const SHOWN = 30;
const PENDING_SHOWN = 200;

const unquote = (line) => JSON.parse(line.slice(line.indexOf('"')));

/** The live entries of a `.po` text as `{ id, translation, files }`; the header and `#~` entries are left out. */
export function readEntries(text) {
  const entries = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n").filter((line) => !line.startsWith("#"));
    if (block.split("\n").some((line) => line.startsWith("#~"))) continue;
    const field = { msgid: "", msgstr: "" };
    let current = null;
    for (const line of lines) {
      const name = line.match(/^(msgid|msgstr) "/)?.[1];
      if (name) current = name;
      else if (!line.startsWith('"')) current = null;
      if (current && (name || line.startsWith('"'))) field[current] += unquote(line);
    }
    const files = block
      .split("\n")
      .filter((line) => line.startsWith("#:"))
      .flatMap((line) => line.slice(2).trim().split(/\s+/))
      .map((ref) => ref.replace(/:\d+$/, ""))
      .filter(Boolean);
    if (field.msgid !== "") entries.push({ id: field.msgid, translation: field.msgstr, files });
  }
  return entries;
}

/** The ids whose translation is empty, or the English source and not in `same`. */
export function untranslated(entries, same) {
  return entries
    .filter(({ id, translation }) => translation === "" || (translation === id && !same.has(id)))
    .map(({ id }) => id);
}

/** Splits the untranslated entries into the fork's and upstream's; `upstream` and `rules` are absent without a file list. */
export function bySource(entries, { upstream, rules }) {
  const fork = [];
  const pending = [];
  for (const { id, files } of entries) {
    const fromUpstream =
      upstream !== undefined &&
      files.length > 0 &&
      files.every((file) => upstream.has(file)) &&
      !(rules.replaced.some((text) => text.includes(id)) && !rules.found.some((text) => text.includes(id)));
    (fromUpstream ? pending : fork).push(id);
  }
  return { fork, pending };
}

/** What the brand rules look for in upstream's files and what they put there instead. */
function readRules(brandFile) {
  const { anchored } = JSON.parse(fs.readFileSync(brandFile, "utf8"));
  return { found: anchored.map(({ find }) => find), replaced: anchored.map(({ replace }) => replace) };
}

export function main(argv, { sameFile = SAME_AS_ENGLISH, brandFile = BRAND } = {}) {
  const usage = { code: 2, lines: ["TURKISH: FAIL (usage: --root <tree> [--upstream-files <list>])"] };
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) options.set(argv[i], argv[i + 1]);
  const root = options.get("--root");
  const listFile = options.get("--upstream-files");
  if (!root || argv.length % 2 !== 0 || [...options.keys()].some((k) => !["--root", "--upstream-files"].includes(k)))
    return usage;
  let entries;
  let same;
  let sources = {};
  try {
    entries = readEntries(fs.readFileSync(path.join(root, CATALOG), "utf8"));
    same = new Set(JSON.parse(fs.readFileSync(sameFile, "utf8")));
    if (listFile)
      sources = {
        upstream: new Set(fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean)),
        rules: readRules(brandFile),
      };
  } catch (error) {
    return { code: 2, lines: [`TURKISH: FAIL (${error.message})`] };
  }
  const { fork, pending } = bySource(
    entries.filter(({ id, translation }) => untranslated([{ id, translation }], same).length > 0),
    sources,
  );
  const lines = pending.slice(0, PENDING_SHOWN).map((id) => `pending: ${JSON.stringify(id)}`);
  if (pending.length > PENDING_SHOWN) lines.push(`pending: ... and ${pending.length - PENDING_SHOWN} more ids`);
  if (fork.length === 0) {
    const waiting = pending.length > 0 ? `; ${pending.length} upstream ids pending translation` : ", none still English";
    lines.push(`TURKISH: PASS (${entries.length} ids${waiting})`);
    return { code: 0, lines };
  }
  lines.push(...fork.slice(0, SHOWN).map((id) => JSON.stringify(id)));
  if (fork.length > SHOWN) lines.push(`... and ${fork.length - SHOWN} more ids`);
  lines.push(
    `TURKISH: FAIL (${fork.length} of ${entries.length} ids are empty or English in Turkish: translate them in a brand rule on the Turkish catalog, or list a term Turkish keeps in English in dozo/brand/catalog-turkish-same.json)`,
  );
  return { code: 2, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
