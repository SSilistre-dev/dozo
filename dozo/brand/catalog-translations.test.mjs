import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir, tree } from "./brand.test-support.mjs";
import { loadTranslations } from "./catalog-fill.mjs";
import { main, validateTranslation } from "./catalog-translations.mjs";

// The check that a translation keeps what the code fills in: placeholders, tags and ICU branches.

const problems = (language, source, translation) => validateTranslation(language, source, translation);
const HEADER = 'msgid ""\nmsgstr ""\n\n';
const po = (...entries) => `${HEADER}${entries.join("\n\n")}\n`;
const catalogPath = (language) => `packages/i18n/locales/${language}/messages.po`;
const withTranslations = (files) => {
  const dir = tempDir();
  for (const [language, entries] of Object.entries(files))
    fs.writeFileSync(path.join(dir, `${language}.json`), JSON.stringify(entries));
  return dir;
};

describe("validateTranslation", () => {
  it("accepts a translation that keeps its placeholders, tags and branches", () => {
    assert.deepEqual(problems("de", "Upgrade to {plan}", "Auf {plan} wechseln"), []);
    assert.deepEqual(problems("de", "Read <0>the docs</0> <1/>", "Lies <0>die Doku</0> <1/>"), []);
    assert.deepEqual(
      problems("de", "{n, plural, one {# bot} other {# bots}}", "{n, plural, one {# Bot} other {# Bots}}"),
      [],
    );
    assert.deepEqual(problems("de", "Don't stop", "Nicht anhalten"), []);
    assert.deepEqual(problems("fr", "Agent {name}", "L''agent {name}"), []);
    assert.deepEqual(problems("de", "Same", "Same"), []);
  });

  it("rejects a lost, added or renamed placeholder", () => {
    assert.match(problems("de", "Upgrade to {plan}", "Auf Plan wechseln")[0], /placeholders/);
    assert.match(problems("de", "Upgrade", "Auf {plan} wechseln")[0], /placeholders/);
    assert.match(problems("de", "Upgrade to {plan}", "Auf {Plan} wechseln")[0], /placeholders/);
    assert.match(problems("de", "Hi {0}", "Hallo {1}")[0], /placeholders/);
  });

  it("rejects a changed tag", () => {
    assert.match(problems("de", "<0>Docs</0>", "Doku")[0], /tags/);
    assert.match(problems("de", "<0>Docs</0>", "<1>Doku</1>")[0], /tags/);
  });

  it("rejects text the ICU parser would not read", () => {
    assert.match(problems("de", "Hi {name}", "Hallo {name")[0], /ICU/);
    assert.match(problems("de", "Hi {name}", "Hallo name}")[0], /ICU/);
    assert.match(problems("de", "Hi {name}", "Hallo {}")[0], /ICU/);
    assert.match(problems("de", "Hi {name}", "Hallo {name, }")[0], /ICU/);
    assert.match(problems("de", "{n, plural, other {x}}", "{n, plural, other {x")[0], /never closed/);
    assert.match(problems("de", "Hi {name}", "Hallo {name, bogus, x}")[0], /ICU/);
    assert.match(problems("de", "{n, plural, other {x}}", "{n, plural, one {x}}")[0], /other/);
    assert.match(problems("de", "{n, plural, other {x}}", "{n, plural, other x}")[0], /ICU/);
    assert.match(problems("de", "{n, plural, other {x}}", "{n, plural, other {x}")[0], /ICU/);
    assert.match(problems("de", "{n, plural, other {x}}", "{n, plural, }")[0], /ICU/);
    assert.match(problems("de", "Hi {name}", "Hallo {name, plural, other {{x}}}")[0], /placeholders/);
  });

  it("treats an apostrophe before a brace as a quote, so it cannot swallow a placeholder", () => {
    assert.match(problems("fr", "Agent {name}", "L'agent '{name}")[0], /placeholders|ICU/);
    assert.deepEqual(problems("fr", "Agent {name}", "L'agent {name}"), []);
    assert.deepEqual(problems("fr", "Curly braces are quoted", "Les '{accolades}' sont ''citées''"), []);
  });

  it("holds a plural to the categories of the language and a select to its source keys", () => {
    const plural = "{n, plural, one {# bot} other {# bots}}";
    assert.match(problems("pl", plural, "{n, plural, one {# bot} other {# botów}}")[0], /few/);
    assert.deepEqual(
      problems("pl", plural, "{n, plural, one {# bot} few {# boty} many {# botów} other {# bota}}"),
      [],
    );
    assert.match(problems("ja", plural, "{n, plural, one {# bot} other {# bot}}")[0], /one/);
    assert.deepEqual(problems("ja", plural, "{n, plural, other {# bot}}"), []);
    const exact = "{n, plural, =0 {None} one {# bot} other {# bots}}";
    assert.deepEqual(problems("de", exact, "{n, plural, =0 {Keine} one {# Bot} other {# Bots}}"), []);
    assert.match(problems("de", exact, "{n, plural, one {# Bot} other {# Bots}}")[0], /=0/);
    const select = "{role, select, admin {Admin} other {Member}}";
    assert.deepEqual(problems("de", select, "{role, select, admin {Admin} other {Mitglied}}"), []);
    assert.match(problems("de", select, "{role, select, administrator {Admin} other {Mitglied}}")[0], /select/);
  });

  it("reads typed arguments, offsets and an unterminated quote", () => {
    assert.deepEqual(problems("de", "{n, number} bots", "{n, number} Bots"), []);
    assert.deepEqual(
      problems("de", "{n, plural, offset:1 one {x} other {y}}", "{n, plural, offset:1 one {x} other {y}}"),
      [],
    );
    assert.deepEqual(problems("de", "Quote '{here", "Zitat '{hier"), []);
  });

  it("ignores a branch the source does not have", () => {
    assert.deepEqual(problems("de", "Messages about {n} things", "{n, plural, one {x} other {y}}"), []);
  });

  it("lists a translation far longer than its source", () => {
    assert.match(problems("de", "Bots", "x".repeat(40))[0], /long/);
    assert.deepEqual(problems("de", "Bots", "Bots Bots Bots"), []);
  });

  it("rejects an empty translation", () => {
    assert.match(problems("de", "Bots", "")[0], /empty/);
  });
});

describe("loadTranslations", () => {
  it("reads one file per language, named after its catalog folder", () => {
    const dir = withTranslations({ de: { Bots: "Bots" }, "pt-BR": { Chat: "Conversa", "to\u0004Chat": "Para" } });
    fs.writeFileSync(path.join(dir, "README.md"), "not a language");
    const loaded = loadTranslations(dir);
    assert.deepEqual([...loaded.keys()], ["de", "pt-BR"]);
    assert.equal(loaded.get("pt-BR").get("\u0004Chat"), "Conversa");
    assert.equal(loaded.get("de").get("\u0004Bots"), "Bots");
    assert.equal(loaded.get("pt-BR").get("to\u0004Chat"), "Para");
    assert.equal(loadTranslations(path.join(dir, "missing")).size, 0);
  });
});

describe("the translations check", () => {
  const english = (id) => `msgid ${JSON.stringify(id)}\nmsgstr ${JSON.stringify(id)}`;
  const root = () =>
    tree({
      [catalogPath("en")]: po(english("Bots"), english("Hi {name}")),
      [catalogPath("de")]: po(english("Bots"), english("Hi {name}")),
    });

  it("passes and counts what each language translated and what is still English", () => {
    const dir = withTranslations({ de: { "Hi {name}": "Hallo {name}", Unused: "Ungenutzt" } });
    const { code, lines } = main(["--root", root(), "--dir", dir]);
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /de: 2 translated, 2 still English, 1 not in the catalog/);
    assert.match(lines.at(-1), /^TRANSLATIONS: PASS \(2 translations in 1 languages/);
  });

  it("fails with the language, the id and the problem", () => {
    const dir = withTranslations({ de: { "Hi {name}": "Hallo {nom}" } });
    const { code, lines } = main(["--dir", dir]);
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /de: "Hi \{name\}": placeholders/);
    assert.match(lines.at(-1), /^TRANSLATIONS: FAIL \(1 translation/);
  });

  it("lists the first problems and counts the rest", () => {
    const entries = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`Hi ${i} {n}`, `Hallo ${i}`]));
    const { lines } = main(["--dir", withTranslations({ de: entries })]);
    assert.equal(lines.length, 42);
    assert.match(lines.at(-2), /and 5 more/);
  });

  it("runs from the command line", () => {
    const script = fileURLToPath(new URL("./catalog-translations.mjs", import.meta.url));
    const dir = withTranslations({ de: { Bots: "Bots" } });
    const run = spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /TRANSLATIONS: PASS/);
  });

  it("fails on an unreadable file, an unknown option and a language with no catalog", () => {
    const bad = tempDir();
    fs.writeFileSync(path.join(bad, "de.json"), "{");
    assert.equal(main(["--dir", bad]).code, 2);
    assert.equal(main(["--nope"]).code, 2);
    assert.equal(main(["--root"]).code, 2);
    const dir = withTranslations({ xx: { Bots: "Bots" } });
    const { code, lines } = main(["--root", root(), "--dir", dir]);
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /xx: no catalog/);
  });

  it("ships translations that pass", () => {
    const { code, lines } = main([]);
    assert.equal(code, 0, lines.join("\n"));
  });
});
