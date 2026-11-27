#!/usr/bin/env node
/**
 * The fork's translations keep what the code fills in.
 *
 *   node dozo/brand/catalog-translations.mjs [--root <branded tree>] [--dir <translations>]
 *
 * `translations/<language>.json` (applied by `catalog-fill.mjs`) holds what a model translated, and
 * nobody who speaks the language has read it. A lost `{name}`, a changed `<0>` tag, a plural without
 * the language's categories or a stray apostrophe would break a screen at run time, so every
 * translation is held to its English source: the same placeholders and tags, ICU that parses, a
 * plural with exactly the categories the language has (and the source's `=N` branches), a select
 * with the source's keys. One longer than 2.5 times its source is reported as a failure too: a
 * label that long overflows the control it is in.
 *
 * With `--root` (the branded tree) it also counts, per language, how many entries are still English
 * there and how many translations name an id the catalog no longer has (reported, not a failure:
 * upstream removes strings).
 *
 * Prints `TRANSLATIONS: PASS (...)` and exits 0, or the problems and `TRANSLATIONS: FAIL (...)` and exits 2.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { catalogEntries, LOCALES, loadTranslations } from "./catalog-fill.mjs";

const MAX_LENGTH_FACTOR = 2.5;
const MIN_LONG = 24; // a two-letter label has no room to grow, but a short phrase does
const SHOWN = 40;
const SELECTORS = new Set(["plural", "select", "selectordinal"]);

class IcuError extends Error {}

/** What the message needs from its caller: argument names, tag numbers, and the branch keys of each plural and select. */
function parseIcu(message) {
  const args = new Set();
  const branches = [];
  let at = 0;

  function text(nested) {
    while (at < message.length) {
      const char = message[at];
      if (char === "'" && message[at + 1] === "'") at += 2;
      else if (char === "'" && (message[at + 1] === "{" || message[at + 1] === "}")) {
        const end = message.indexOf("'", at + 1);
        if (end === -1) at = message.length;
        else at = end + 1;
      } else if (char === "{") {
        at++;
        argument();
      } else if (char === "}") {
        if (nested) return;
        throw new IcuError("a } with no { before it");
      } else at++;
    }
    if (nested) throw new IcuError("a { that is never closed");
  }

  function argument() {
    const close = message.slice(at).search(/[,}]/);
    if (close === -1) throw new IcuError("a { that is never closed");
    const name = message.slice(at, at + close).trim();
    if (!/^[\w.]+$/.test(name)) throw new IcuError(`"${name}" is not an argument name`);
    args.add(name);
    at += close;
    if (message[at] === "}") {
      at++;
      return;
    }
    at++;
    const kind = message.slice(at).match(/^\s*(\w+)\s*(,|\})/);
    if (!kind) throw new IcuError(`argument ${name} has no type`);
    at += kind[0].length;
    if (kind[2] === "}") return;
    if (!SELECTORS.has(kind[1])) throw new IcuError(`argument ${name} has type ${kind[1]}`);
    const keys = [];
    let key = message.slice(at).match(/^\s*(?:offset:\d+\s*)?([^\s{}]+)\s*\{/);
    while (key) {
      keys.push(key[1]);
      at += key[0].length;
      text(true);
      at++;
      key = message.slice(at).match(/^\s*([^\s{}]+)\s*\{/);
    }
    if (!/^\s*\}/.test(message.slice(at))) throw new IcuError(`argument ${name} has a branch with no braces`);
    at = message.indexOf("}", at) + 1;
    if (!keys.includes("other")) throw new IcuError(`argument ${name} has no other branch`);
    branches.push({ name, kind: kind[1], keys });
  }

  text(false);
  const tags = new Set([...message.matchAll(/<\/?(\d+)\/?>/g)].map((m) => m[1]));
  return { args, tags, branches };
}

const same = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

/** The problems of `translation` as the `language` translation of `source`; none when it can ship. */
export function validateTranslation(language, source, translation) {
  if (translation === "") return ["empty"];
  const problems = [];
  let want;
  let have;
  try {
    want = parseIcu(source);
    have = parseIcu(translation);
  } catch (error) {
    return [`ICU: ${error.message}`];
  }
  if (!same(want.args, have.args))
    problems.push(`placeholders ${[...want.args].join(", ")} became ${[...have.args].join(", ")}`);
  if (!same(want.tags, have.tags))
    problems.push(`tags ${[...want.tags].join(", ")} became ${[...have.tags].join(", ")}`);
  const categories = new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
  for (const branch of have.branches) {
    const original = want.branches.find((b) => b.name === branch.name && b.kind === branch.kind);
    if (!original) continue;
    if (branch.kind === "select") {
      if (!same(new Set(original.keys), new Set(branch.keys)))
        problems.push(`select ${branch.name} keys ${original.keys.join(", ")} became ${branch.keys.join(", ")}`);
      continue;
    }
    const exact = (keys) => new Set(keys.filter((key) => key.startsWith("=")));
    if (!same(exact(original.keys), exact(branch.keys)))
      problems.push(`plural ${branch.name} lost or added an exact branch (${[...exact(original.keys)].join(", ") || "none"} became ${[...exact(branch.keys)].join(", ") || "none"})`);
    const words = new Set(branch.keys.filter((key) => !key.startsWith("=")));
    for (const category of categories)
      if (!words.has(category)) problems.push(`plural ${branch.name} lacks ${category}`);
    for (const word of words)
      if (!categories.has(word)) problems.push(`plural ${branch.name} has ${word}, which ${language} does not use`);
  }
  if (translation.length > Math.max(source.length * MAX_LENGTH_FACTOR, MIN_LONG))
    problems.push(`long: ${translation.length} characters for ${source.length}`);
  return problems;
}

const keyId = (key) => key.slice(key.indexOf("\u0004") + 1);
const show = (key) => JSON.stringify(keyId(key));

export function main(argv) {
  const options = { root: undefined, dir: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    if (!(name in options) || argv[i + 1] === undefined)
      return { code: 2, lines: [`TRANSLATIONS: FAIL (usage: [--root <tree>] [--dir <translations>])`] };
    options[name] = argv[i + 1];
  }
  let translations;
  try {
    translations = loadTranslations(options.dir);
  } catch (error) {
    return { code: 2, lines: [`TRANSLATIONS: FAIL (${error.message})`] };
  }
  const problems = [];
  const lines = [];
  let total = 0;
  for (const [language, entries] of translations) {
    let catalog;
    if (options.root) {
      const file = path.join(options.root, LOCALES, language, "messages.po");
      if (!fs.existsSync(file)) {
        problems.push(`${language}: no catalog in the tree`);
        continue;
      }
      catalog = catalogEntries(fs.readFileSync(file, "utf8"));
    }
    for (const [key, translation] of entries) {
      for (const problem of validateTranslation(language, keyId(key), translation))
        problems.push(`${language}: ${show(key)}: ${problem}`);
    }
    total += entries.size;
    const summary = [`${language}: ${entries.size} translated`];
    if (catalog) {
      const english = [...catalog].filter(([key, entry]) => entry.translation === keyId(key)).length;
      const unused = [...entries.keys()].filter((key) => !catalog.has(key)).length;
      summary.push(`${english} still English`, `${unused} not in the catalog`);
    }
    lines.push(summary.join(", "));
  }
  if (problems.length === 0)
    return {
      code: 0,
      lines: [...lines, `TRANSLATIONS: PASS (${total} translations in ${translations.size} languages)`],
    };
  const shown = problems.slice(0, SHOWN);
  if (problems.length > SHOWN) shown.push(`... and ${problems.length - SHOWN} more`);
  return {
    code: 2,
    lines: [...shown, `TRANSLATIONS: FAIL (${problems.length} translation problems; fix them in dozo/brand/translations)`],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
