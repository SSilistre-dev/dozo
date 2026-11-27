/**
 * The fork's Turkish catalog holds every string the fork adds (brand rules put them there), and
 * the other language catalogs do not. This step, run by `apply.mjs` on the tree it brands, gives
 * each id (with its context) that Turkish has and another catalog lacks an entry whose
 * translation is the English source, with the comments and flags of the Turkish one.
 *
 * Then the fork's own translations (`translations/<language>.json`, an object from the English
 * source, or `context` + U+0004 + source, to the translation) replace every entry still English:
 * the ones just added and upstream's untranslated ones. A translation someone already wrote in the
 * catalog is never replaced, so upstream translating a string wins over the fork's. The files
 * hold what a model translated; `catalog-translations.mjs` checks them.
 *
 * Why: the web build compiles the missing ones from its own extraction only when they are
 * template ids, and an explicit id's message with a placeholder stays uncompiled (shown as
 * `Upgrade to {plan}`). With the entry in the catalog every language compiles it. Deterministic
 * (Turkish order, appended at the end), idempotent (a second run finds nothing missing), offline.
 * `catalog-parity.mjs` is the check that it ran.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = "packages/i18n/locales";
export const TRANSLATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "translations");
export const SOURCE_LANGUAGE = "tr";

const unquote = (text) => JSON.parse(`"${text}"`);
const KEY_SEPARATOR = "\u0004";

/** A `.po` file's entries by `msgctxt`, then id: the entry's comments, context lines and id lines as written, and its translation as text. The header and `#~` obsolete entries are left out. */
export function catalogEntries(text) {
  const entries = new Map();
  for (const block of text.split(/\n\n+/)) {
    const comments = [];
    const context = [];
    const id = [];
    const translation = [];
    let part = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("msgid_plural "))
        throw new Error(`a plural entry is not supported: ${line}`);
      const field = line.match(/^(msgctxt|msgid|msgstr) "/);
      if (field) part = field[1];
      else if (!line.startsWith('"') && line.startsWith("#") && !line.startsWith("#~"))
        comments.push(line);
      else if (!line.startsWith('"')) part = null;
      if (part === "msgctxt") context.push(line);
      else if (part === "msgid") id.push(line);
      else if (part === "msgstr") translation.push(line);
    }
    const joined = (lines) =>
      lines.map((line) => unquote(line.slice(line.indexOf('"') + 1, -1))).join("");
    const key = `${joined(context)}${KEY_SEPARATOR}${joined(id)}`;
    if (joined(id) !== "") entries.set(key, { comments, context, id, translation: joined(translation) });
  }
  return entries;
}

const PLURAL_HEADER = /\{\s*[\w.]+\s*,\s*plural\s*,/g;

/** The index of the `}` that closes the `{` at `open`, or -1. */
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The ICU message with every `plural` block given the categories `language`
 * has and the block lacks, each with the `other` branch's text. Existing branches stay as written.
 */
export function withPluralCategories(message, language) {
  let result = "";
  let from = 0;
  PLURAL_HEADER.lastIndex = 0;
  for (let match = PLURAL_HEADER.exec(message); match; match = PLURAL_HEADER.exec(message)) {
    const end = closingBrace(message, match.index);
    if (end === -1) break;
    const body = message.slice(match.index + match[0].length, end);
    const branches = [];
    let rest = body;
    for (let m = rest.match(/^\s*(\S+?)\s*\{/); m; m = rest.match(/^\s*(\S+?)\s*\{/)) {
      const open = m[0].length - 1;
      const close = closingBrace(rest, open);
      if (close === -1) break;
      branches.push({
        selector: m[1],
        text: withPluralCategories(rest.slice(open + 1, close), language),
      });
      rest = rest.slice(close + 1);
    }
    const other = branches.find((branch) => branch.selector === "other");
    if (other && rest.trim() === "") {
      const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
      for (const category of categories)
        if (!branches.some((branch) => branch.selector === category))
          branches.push({ selector: category, text: other.text });
      const inner = branches.map((branch) => `${branch.selector} {${branch.text}}`).join(" ");
      result += `${message.slice(from, match.index)}${match[0]} ${inner}}`;
    } else result += message.slice(from, end + 1);
    from = end + 1;
    PLURAL_HEADER.lastIndex = from;
  }
  return result + message.slice(from);
}

const joinedId = (lines) =>
  lines.map((line) => unquote(line.slice(line.indexOf('"') + 1, -1))).join("");

/** The English source as the translation: the id's own lines, with plural categories the language needs added. */
function asString(lines, language) {
  const id = joinedId(lines);
  const message = withPluralCategories(id, language);
  if (message === id)
    return lines.map((line, i) => (i === 0 ? line.replace(/^msgid /, "msgstr ") : line));
  return [`msgstr ${JSON.stringify(message)}`];
}

/** `Map<language, Map<key, translation>>` from the `<language>.json` files of `dir`, the keys as `catalogEntries` makes them (a key with no context gets the empty one). */
export function loadTranslations(dir = TRANSLATIONS) {
  const byLanguage = new Map();
  if (!fs.existsSync(dir)) return byLanguage;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const keyed = Object.entries(entries).map(([key, text]) => [
      key.includes(KEY_SEPARATOR) ? key : `${KEY_SEPARATOR}${key}`,
      text,
    ]);
    byLanguage.set(file.slice(0, -".json".length), new Map(keyed));
  }
  return byLanguage;
}

/** `text` with the `msgstr` of every entry still English (or empty) that `translations` has replaced, and how many. */
function applyTranslations(text, translations) {
  let count = 0;
  const parts = text.split(/(\n\n+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const lines = parts[i].split("\n");
    const at = lines.findIndex((line) => line.startsWith("msgstr "));
    const [key] = at === -1 ? [] : [...catalogEntries(parts[i]).keys()];
    const translation = translations.get(key);
    if (translation === undefined) continue;
    const current = joinedId(lines.slice(at));
    if (current !== "" && current !== key.slice(key.indexOf(KEY_SEPARATOR) + 1)) continue;
    parts[i] = [...lines.slice(0, at), `msgstr ${JSON.stringify(translation)}`].join("\n");
    count++;
  }
  return { text: parts.join(""), count };
}

/**
 * The catalogs to rewrite: `read(rel)` returns a file's text (the branded one if the brand step
 * changed it). Returns `Map<rel, text>` of the catalogs that changed, how many entries were added
 * and how many were translated.
 */
export function fillCatalogs(root, read, translations = loadTranslations()) {
  const dir = path.join(root, LOCALES);
  const source = path.join(dir, SOURCE_LANGUAGE, "messages.po");
  if (!fs.existsSync(source)) return { changed: new Map(), added: 0, translated: 0 };
  const rel = (language) => `${LOCALES}/${language}/messages.po`;
  const fromSource = catalogEntries(read(rel(SOURCE_LANGUAGE)));
  const changed = new Map();
  let added = 0;
  let translated = 0;
  for (const language of fs.readdirSync(dir).sort()) {
    if (language === SOURCE_LANGUAGE || !fs.existsSync(path.join(dir, language, "messages.po")))
      continue;
    const text = read(rel(language));
    const have = catalogEntries(text);
    const blocks = [];
    for (const [key, entry] of fromSource) {
      if (have.has(key)) continue;
      blocks.push(
        [...entry.comments, ...entry.context, ...entry.id, ...asString(entry.id, language)].join(
          "\n",
        ),
      );
    }
    const filled =
      blocks.length === 0 ? text : `${text.replace(/\n*$/, "\n")}\n${blocks.join("\n\n")}\n`;
    const result = applyTranslations(filled, translations.get(language) ?? new Map());
    if (result.text === text) continue;
    changed.set(rel(language), result.text);
    added += blocks.length;
    translated += result.count;
  }
  return { changed, added, translated };
}
