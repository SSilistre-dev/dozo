#!/usr/bin/env node
/**
 * Catalog parity: every message id in one shipped language catalog is in all of them.
 *
 *   node dozo/brand/catalog-parity.mjs --root <branded tree>
 *
 * The web and mobile apps ship one catalog per language (`packages/i18n/locales/<lang>/messages.po`).
 * The production web build strips a message's source text, so an id a language lacks is not
 * translated: it shows nothing useful (a raw id) in that language. The fork adds its Turkish copy
 * through brand rules, and `catalog-fill.mjs` (run by `apply.mjs`) gives each such id its English
 * source in every other catalog. This proves it ran: run it on the branded tree.
 *
 * Prints `CATALOGS: PASS (...)` and exits 0, or the ids with the languages that lack them and
 * `CATALOGS: FAIL (...)` and exits 2. A tree with fewer than two catalogs fails too.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { catalogEntries } from "./catalog-fill.mjs";

const LOCALES = path.join("packages", "i18n", "locales");
const SHOWN = 30;

/** The ids of one `.po` file as `msgctxt`-prefixed keys. */
export const catalogIds = (text) => new Set(catalogEntries(text).keys());

const show = (key) => {
  const [context, id] = key.split("\u0004");
  return context ? `${id} (context ${context})` : id;
};

/** The languages and, per id, those that lack it. */
export function compareCatalogs(byLanguage) {
  const languages = Object.keys(byLanguage).sort();
  const all = new Set(languages.flatMap((language) => [...byLanguage[language]]));
  const missing = new Map();
  for (const key of [...all].sort()) {
    const lacking = languages.filter((language) => !byLanguage[language].has(key));
    if (lacking.length > 0) missing.set(key, lacking);
  }
  return { languages, total: all.size, missing };
}

export function main(argv) {
  const root = argv[0] === "--root" ? argv[1] : undefined;
  if (!root || argv.length !== 2)
    return { code: 2, lines: ["CATALOGS: FAIL (usage: --root <tree>)"] };
  const dir = path.join(root, LOCALES);
  const byLanguage = {};
  try {
    for (const language of fs.readdirSync(dir)) {
      byLanguage[language] = catalogIds(
        fs.readFileSync(path.join(dir, language, "messages.po"), "utf8"),
      );
    }
  } catch (error) {
    return { code: 2, lines: [`CATALOGS: FAIL (${error.message})`] };
  }
  const { languages, total, missing } = compareCatalogs(byLanguage);
  if (languages.length < 2)
    return {
      code: 2,
      lines: [`CATALOGS: FAIL (found ${languages.length} catalog under ${LOCALES})`],
    };
  if (missing.size === 0)
    return {
      code: 0,
      lines: [`CATALOGS: PASS (${total} ids in each of ${languages.length} catalogs)`],
    };
  const where = (lacking) =>
    lacking.length > languages.length / 2
      ? `only in ${languages.filter((language) => !lacking.includes(language)).join(", ")}`
      : `missing from ${lacking.join(", ")}`;
  const lines = [...missing]
    .slice(0, SHOWN)
    .map(([key, lacking]) => `${show(key)}: ${where(lacking)}`);
  if (missing.size > SHOWN) lines.push(`... and ${missing.size - SHOWN} more ids`);
  const counts = languages
    .map((language) => [
      language,
      [...missing.values()].filter((lacking) => lacking.includes(language)).length,
    ])
    .filter(([, count]) => count > 0)
    .map(([language, count]) => `${language} ${count}`);
  lines.push(
    `CATALOGS: FAIL (${missing.size} of ${total} ids are missing from some catalog: ${counts.join(", ")}; the brand step's catalog fill (dozo/brand/catalog-fill.mjs) did not run or could not add it)`,
  );
  return { code: 2, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
