/**
 * The fork's Turkish catalog holds every string the fork adds (brand rules put them there), and
 * the other language catalogs do not. This step, run by `apply.mjs` on the tree it brands, gives
 * each id (with its context) that Turkish has and another catalog lacks an entry whose
 * translation is the English source, with the comments and flags of the Turkish one.
 *
 * Why: the web build compiles the missing ones from its own extraction only when they are
 * template ids, and an explicit id's message with a placeholder stays uncompiled (shown as
 * `Upgrade to {plan}`). With the entry in the catalog every language compiles it. Deterministic
 * (Turkish order, appended at the end), idempotent (a second run finds nothing missing), offline.
 * `catalog-parity.mjs` is the check that it ran.
 */
import fs from "node:fs";
import path from "node:path";

export const LOCALES = "packages/i18n/locales";
export const SOURCE_LANGUAGE = "tr";

const unquote = (text) => JSON.parse(`"${text}"`);
const KEY_SEPARATOR = "\u0004";

/** A `.po` file's entries by `msgctxt`, then id: the entry's comments, context lines and id lines as written. The header and `#~` obsolete entries are left out. */
export function catalogEntries(text) {
  const entries = new Map();
  for (const block of text.split(/\n\n+/)) {
    const comments = [];
    const context = [];
    const id = [];
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
    }
    const joined = (lines) =>
      lines.map((line) => unquote(line.slice(line.indexOf('"') + 1, -1))).join("");
    const key = `${joined(context)}${KEY_SEPARATOR}${joined(id)}`;
    if (joined(id) !== "") entries.set(key, { comments, context, id });
  }
  return entries;
}

const asString = (lines) =>
  lines.map((line, i) => (i === 0 ? line.replace(/^msgid /, "msgstr ") : line));

/**
 * The catalogs to rewrite: `read(rel)` returns a file's text (the branded one if the brand step
 * changed it). Returns `Map<rel, text>` of the catalogs that gained entries, and how many.
 */
export function fillCatalogs(root, read) {
  const dir = path.join(root, LOCALES);
  const source = path.join(dir, SOURCE_LANGUAGE, "messages.po");
  if (!fs.existsSync(source)) return { changed: new Map(), added: 0 };
  const rel = (language) => `${LOCALES}/${language}/messages.po`;
  const fromSource = catalogEntries(read(rel(SOURCE_LANGUAGE)));
  const changed = new Map();
  let added = 0;
  for (const language of fs.readdirSync(dir).sort()) {
    if (language === SOURCE_LANGUAGE || !fs.existsSync(path.join(dir, language, "messages.po")))
      continue;
    const text = read(rel(language));
    const have = catalogEntries(text);
    const blocks = [];
    for (const [key, entry] of fromSource) {
      if (have.has(key)) continue;
      blocks.push(
        [...entry.comments, ...entry.context, ...entry.id, ...asString(entry.id)].join("\n"),
      );
    }
    if (blocks.length === 0) continue;
    changed.set(rel(language), `${text.replace(/\n*$/, "\n")}\n${blocks.join("\n\n")}\n`);
    added += blocks.length;
  }
  return { changed, added };
}
