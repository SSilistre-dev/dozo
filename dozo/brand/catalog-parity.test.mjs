import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogIds, compareCatalogs, main } from "./catalog-parity.mjs";

// The check behind `make olc`: every message id is in every shipped catalog of the branded tree.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEADER = 'msgid ""\nmsgstr ""\n"Language: xx\\n"\n"X-Generator: @lingui/cli\\n"\n\n';
const entry = (id, str = id, context) =>
  `${context ? `msgctxt "${context}"\n` : ""}msgid "${id}"\nmsgstr "${str}"\n\n`;

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A tree whose catalogs hold the given `.po` bodies, by language. */
function tree(catalogs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-parity-"));
  scratch.push(root);
  for (const [language, body] of Object.entries(catalogs)) {
    const dir = path.join(root, "packages", "i18n", "locales", language);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "messages.po"), HEADER + body);
  }
  return root;
}

describe("catalogIds", () => {
  it("reads ids with their context, joins wrapped ones, and skips the header and obsolete entries", () => {
    const text = `${HEADER}#: a.tsx\n${entry("To", "Kime", "recipient")}${entry("To")}msgid ""\n"Wrapped "\n"id"\nmsgstr ""\n\n#~ msgid "Gone"\n#~ msgstr "Gone"\n`;
    assert.deepEqual(
      [...catalogIds(text)].sort(),
      ["\u0004To", "\u0004Wrapped id", "recipient\u0004To"].sort(),
    );
  });

  it("joins a wrapped context", () => {
    assert.deepEqual(
      [...catalogIds('msgctxt ""\n"re"\n"cipient"\nmsgid "To"\nmsgstr "To"\n')],
      ["recipient\u0004To"],
    );
  });
});

describe("compareCatalogs", () => {
  it("lists, per id, the languages that lack it", () => {
    const { languages, total, missing } = compareCatalogs({
      tr: new Set(["a", "b"]),
      de: new Set(["a"]),
    });
    assert.deepEqual(languages, ["de", "tr"]);
    assert.equal(total, 2);
    assert.deepEqual([...missing], [["b", ["de"]]]);
  });
});

describe("main", () => {
  it("passes when every catalog holds every id", () => {
    const root = tree({
      de: entry("A") + entry("B", "B", "ctx"),
      tr: entry("A", "a") + entry("B", "b", "ctx"),
    });
    assert.deepEqual(main(["--root", root]), {
      code: 0,
      lines: ["CATALOGS: PASS (2 ids in each of 2 catalogs)"],
    });
  });

  it("fails naming the id, its context and the languages that lack it", () => {
    const root = tree({
      de: entry("A"),
      es: entry("A"),
      tr: entry("A") + entry("Access tokens", "Erisim") + entry("To", "Kime", "recipient"),
    });
    const { code, lines } = main(["--root", root]);
    assert.equal(code, 2);
    assert.deepEqual(lines.slice(0, 2), [
      "Access tokens: only in tr",
      "To (context recipient): only in tr",
    ]);
    assert.match(
      lines[2],
      /^CATALOGS: FAIL \(2 of 3 ids are missing from some catalog: de 2, es 2;/,
    );
  });

  it("shows the first ids only and counts the rest", () => {
    const many = Array.from({ length: 33 }, (_, i) => entry(`Id ${i}`)).join("");
    const root = tree({ de: "", tr: many });
    const { code, lines } = main(["--root", root]);
    assert.equal(code, 2);
    assert.equal(lines.length, 32);
    assert.equal(lines[30], "... and 3 more ids");
    assert.equal(lines[0], "Id 0: missing from de");
    assert.match(lines[31], /33 of 33 ids are missing from some catalog: de 33;/);
  });

  it("fails on a tree with one catalog, with none, and on a bad call", () => {
    assert.match(main(["--root", tree({ en: entry("A") })]).lines[0], /found 1 catalog/);
    assert.match(
      main(["--root", os.tmpdir() + "/dozo-no-such-tree"]).lines[0],
      /^CATALOGS: FAIL \(ENOENT/,
    );
    assert.deepEqual(main([]), { code: 2, lines: ["CATALOGS: FAIL (usage: --root <tree>)"] });
    assert.equal(main(["--root", "a", "b"]).code, 2);
  });

  it("runs as a command and exits 2 with its lines for a tree that fails", () => {
    const root = tree({ de: entry("A"), tr: entry("A") + entry("B") });
    const run = spawnSync("node", [path.join(HERE, "catalog-parity.mjs"), "--root", root], {
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    assert.match(run.stdout, /B: missing from de\nCATALOGS: FAIL/);
  });
});
