#!/usr/bin/env node
/**
 * Turkish coverage: no message in the Turkish catalog is still English.
 *
 *   node dozo/brand/catalog-turkish.mjs --root <branded tree after `lingui extract`>
 *
 * `catalog-parity.mjs` only holds the 16 catalogs to the same ids, so a string upstream adds, which
 * extraction writes into Turkish with an empty or English line, passes it. This reads the Turkish
 * catalog after extraction and fails on every live entry whose translation is empty or the English
 * source, unless the id is in `catalog-turkish-same.json`: the words and technical terms Turkish
 * writes as English does (units, protocol names, URLs).
 *
 * Prints `TURKISH: PASS (...)` and exits 0, or the ids and `TURKISH: FAIL (...)` and exits 2.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CATALOG = path.join("packages", "i18n", "locales", "tr", "messages.po");
const SAME_AS_ENGLISH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "catalog-turkish-same.json",
);
const SHOWN = 30;

const unquote = (line) => JSON.parse(line.slice(line.indexOf('"')));

/** The live entries of a `.po` text as `{ id, translation }`; the header and `#~` entries are left out. */
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
    if (field.msgid !== "") entries.push({ id: field.msgid, translation: field.msgstr });
  }
  return entries;
}

/** The ids whose translation is empty, or the English source and not in `same`. */
export function untranslated(entries, same) {
  return entries
    .filter(({ id, translation }) => translation === "" || (translation === id && !same.has(id)))
    .map(({ id }) => id);
}

export function main(argv, sameFile = SAME_AS_ENGLISH) {
  const root = argv[0] === "--root" ? argv[1] : undefined;
  if (!root || argv.length !== 2)
    return { code: 2, lines: ["TURKISH: FAIL (usage: --root <tree>)"] };
  let entries;
  let same;
  try {
    entries = readEntries(fs.readFileSync(path.join(root, CATALOG), "utf8"));
    same = new Set(JSON.parse(fs.readFileSync(sameFile, "utf8")));
  } catch (error) {
    return { code: 2, lines: [`TURKISH: FAIL (${error.message})`] };
  }
  const missing = untranslated(entries, same);
  if (missing.length === 0)
    return { code: 0, lines: [`TURKISH: PASS (${entries.length} ids, none still English)`] };
  const lines = missing.slice(0, SHOWN).map((id) => JSON.stringify(id));
  if (missing.length > SHOWN) lines.push(`... and ${missing.length - SHOWN} more ids`);
  lines.push(
    `TURKISH: FAIL (${missing.length} of ${entries.length} ids are empty or English in Turkish: translate them in a brand rule on the Turkish catalog, or list a term Turkish keeps in English in dozo/brand/catalog-turkish-same.json)`,
  );
  return { code: 2, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
