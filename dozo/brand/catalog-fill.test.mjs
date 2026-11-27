import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { apply, configFile, read, tree } from "./brand.test-support.mjs";
import { catalogEntries, fillCatalogs, withPluralCategories } from "./catalog-fill.mjs";

// The step that gives the Turkish-only ids their English source in the other catalogs.

const HEADER = 'msgid ""\nmsgstr ""\n"Language: xx\\n"\n\n';
const catalog = (...entries) => `${HEADER}${entries.join("\n\n")}\n`;
const po = (language) => `packages/i18n/locales/${language}/messages.po`;
const TURKISH = catalog(
  '#: a.tsx\nmsgid "Shared"\nmsgstr "Ortak"',
  '#. js-lingui-explicit-id\n#: dozo-b.ts\nmsgid "Fixture upgrade to {plan}"\nmsgstr "{plan} planına geç"',
  '#: c.tsx\nmsgctxt "fixture recipient"\nmsgid "To"\nmsgstr "Kime"',
  '#: d.tsx\nmsgid ""\n"Line one\\n"\n"Line two"\nmsgstr ""\n"Satır bir\\n"\n"Satır iki"',
  '#~ msgid "Gone"\n#~ msgstr "Gitti"',
);
const GERMAN = catalog('#: a.tsx\nmsgid "Shared"\nmsgstr "Gemeinsam"');
const files = { [po("tr")]: TURKISH, [po("de")]: GERMAN, [po("en")]: GERMAN };
const readFrom = (root) => (rel) => read(root, rel);

describe("catalogEntries", () => {
  it("keys entries by context and id, keeps their comments and lines, skips the header and obsolete ones", () => {
    const entries = catalogEntries(TURKISH);
    assert.deepEqual(
      [...entries.keys()],
      ["\u0004Shared", "\u0004Fixture upgrade to {plan}", "fixture recipient\u0004To", "\u0004Line one\nLine two"],
    );
    assert.deepEqual(entries.get("\u0004Fixture upgrade to {plan}").comments, [
      "#. js-lingui-explicit-id",
      "#: dozo-b.ts",
    ]);
  });

  it("refuses a plural entry rather than copy it wrongly", () => {
    assert.throws(
      () => catalogEntries('msgid "One"\nmsgid_plural "Many"\nmsgstr[0] "x"'),
      /plural/,
    );
  });
});

describe("fillCatalogs", () => {
  it("appends each Turkish-only id with its comments, context and English source as the translation", () => {
    const root = tree(files);
    const { changed, added } = fillCatalogs(root, readFrom(root));
    assert.equal(added, 6);
    assert.deepEqual([...changed.keys()], [po("de"), po("en")]);
    assert.equal(
      changed.get(po("de")),
      `${GERMAN}\n#. js-lingui-explicit-id\n#: dozo-b.ts\nmsgid "Fixture upgrade to {plan}"\nmsgstr "Fixture upgrade to {plan}"\n\n` +
        '#: c.tsx\nmsgctxt "fixture recipient"\nmsgid "To"\nmsgstr "To"\n\n' +
        '#: d.tsx\nmsgid ""\n"Line one\\n"\n"Line two"\nmsgstr ""\n"Line one\\n"\n"Line two"\n',
    );
  });

  it("gives a plural message the categories the language has, keeping the branches it wrote", () => {
    const message =
      "{count, plural, =0 {None} one {# item} other {# items in {n, plural, other {x}}}}";
    const root = tree({
      ...files,
      [po("tr")]: catalog(`#: e.tsx\nmsgid ${JSON.stringify(message)}\nmsgstr "x"`),
      [po("pl")]: GERMAN,
    });
    const text = fillCatalogs(root, readFrom(root)).changed.get(po("pl"));
    const filled = JSON.parse(text.match(/\nmsgstr ("\{count.*")\n$/)[1]);
    assert.equal(
      filled,
      "{count, plural, =0 {None} one {# item} other {# items in {n, plural, other {x} one {x} few {x} many {x}}} few {# items in {n, plural, other {x} one {x} few {x} many {x}}} many {# items in {n, plural, other {x} one {x} few {x} many {x}}}}",
    );
    assert.equal(withPluralCategories(filled, "pl"), filled);
  });

  it("leaves a plural it cannot read as written", () => {
    for (const message of [
      "{n, plural, one {x}",
      "{n, plural, one {x}}",
      "{n, plural, one {x} other {y",
      "{n, plural, other {y} stray}",
    ])
      assert.equal(withPluralCategories(message, "pl"), message);
  });

  it("finds nothing to do on a catalog it already filled, and on one that has the id with its own words", () => {
    const root = tree(files);
    const { changed } = fillCatalogs(root, readFrom(root));
    for (const [rel, text] of changed) fs.writeFileSync(path.join(root, rel), text);
    assert.equal(fillCatalogs(root, readFrom(root)).added, 0);
    const own = tree({ ...files, [po("de")]: `${TURKISH.replaceAll("Kime", "An")}` });
    assert.equal(fillCatalogs(own, readFrom(own)).changed.has(po("de")), false);
  });

  it("does nothing without a Turkish catalog, and skips a language folder without a catalog", () => {
    const none = tree({ [po("de")]: GERMAN });
    assert.equal(fillCatalogs(none, readFrom(none)).added, 0);
    const empty = tree(files);
    fs.mkdirSync(path.join(empty, "packages/i18n/locales/xx"));
    assert.deepEqual(
      [...fillCatalogs(empty, readFrom(empty)).changed.keys()],
      [po("de"), po("en")],
    );
  });
});

describe("the brand step", () => {
  it("fills the catalogs from the branded Turkish one, and a second run changes nothing", () => {
    const root = tree(files);
    const first = apply(root, configFile());
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /catalogs: 6 entries added to 2 languages/);
    assert.match(read(root, po("de")), /msgid "Fixture upgrade to \{plan\}"\nmsgstr "Fixture upgrade to \{plan\}"/);
    const again = apply(root, configFile());
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /catalogs: 0 entries added to 0 languages/);
  });

  it("only reports in a dry run", () => {
    const root = tree(files);
    const dry = apply(root, configFile(), "--check");
    assert.match(dry.stdout, /catalogs: 6 entries added to 2 languages/);
    assert.equal(read(root, po("de")), GERMAN);
  });
});

describe("translations", () => {
  const turkish = catalog(
    '#: a.tsx\nmsgid "Shared"\nmsgstr "Ortak"',
    '#: b.tsx\nmsgid "Fixture upgrade to {plan}"\nmsgstr "{plan} planına geç"',
    '#: c.tsx\nmsgctxt "fixture recipient"\nmsgid "To"\nmsgstr "Kime"',
  );
  const english = catalog('#: a.tsx\nmsgid "Shared"\nmsgstr "Shared"');
  const german = catalog('#: a.tsx\nmsgid "Shared"\nmsgstr "Gemeinsam"');
  const translations = new Map([
    [
      "de",
      new Map([
        ["\u0004Shared", "Geteilt"],
        ["\u0004Fixture upgrade to {plan}", "Auf {plan} wechseln"],
        ["fixture recipient\u0004To", "An"],
      ]),
    ],
  ]);
  const run = (de) => {
    const root = tree({ [po("tr")]: turkish, [po("de")]: de, [po("en")]: german });
    return { root, ...fillCatalogs(root, readFrom(root), translations) };
  };

  it("gives a new id its translation instead of the English source", () => {
    const { changed } = run(german);
    assert.match(changed.get(po("de")), /msgid "Fixture upgrade to \{plan\}"\nmsgstr "Auf \{plan\} wechseln"/);
    assert.match(changed.get(po("de")), /msgctxt "fixture recipient"\nmsgid "To"\nmsgstr "An"/);
    assert.match(changed.get(po("en")), /msgid "Fixture upgrade to \{plan\}"\nmsgstr "Fixture upgrade to \{plan\}"/);
  });

  it("translates an entry that is still English, and keeps the words someone already wrote", () => {
    const { changed, translated } = run(english);
    assert.match(changed.get(po("de")), /msgid "Shared"\nmsgstr "Geteilt"/);
    assert.equal(translated, 3);
    assert.equal(run(german).changed.get(po("de")).includes("Geteilt"), false);
  });

  it("changes nothing on a catalog it already translated", () => {
    const { root, changed } = run(english);
    for (const [rel, text] of changed) fs.writeFileSync(path.join(root, rel), text);
    const again = fillCatalogs(root, readFrom(root), translations);
    assert.equal(again.added, 0);
    assert.equal(again.translated, 0);
    assert.equal(again.changed.size, 0);
  });

  it("writes a multi-line source translation on one line", () => {
    const multi = catalog('#: d.tsx\nmsgid ""\n"A\\n"\n"B"\nmsgstr ""\n"A\\n"\n"B"');
    const root = tree({ [po("tr")]: multi, [po("de")]: multi, [po("en")]: multi });
    const { changed } = fillCatalogs(root, readFrom(root), new Map([["de", new Map([["\u0004A\nB", "X\nY"]])]]));
    assert.match(changed.get(po("de")), /msgid ""\n"A\\n"\n"B"\nmsgstr "X\\nY"/);
  });
});
