import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main, readEntries, untranslated } from "./catalog-turkish.mjs";

// The check behind `make qa`'s checks step: nothing in the Turkish catalog is left in English.

const HEADER = 'msgid ""\nmsgstr ""\n"Language: tr\\n"\n\n';
const entry = (id, str) => `#: a.tsx\nmsgid "${id}"\nmsgstr "${str}"\n\n`;

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A tree with a Turkish catalog of the given body and the list of terms Turkish keeps. */
function tree(body, same = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-turkish-"));
  scratch.push(root);
  const dir = path.join(root, "packages", "i18n", "locales", "tr");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "messages.po"), HEADER + body);
  const sameFile = path.join(root, "same.json");
  fs.writeFileSync(sameFile, JSON.stringify(same));
  return { root, sameFile };
}

describe("readEntries", () => {
  it("joins wrapped lines and skips the header and obsolete entries", () => {
    const text = `${HEADER}${entry("Hello", "Merhaba")}msgid ""\n"Wrapped "\n"id"\nmsgstr ""\n"Sarılı"\n\n#~ msgid "Gone"\n#~ msgstr "Gone"\n`;
    assert.deepEqual(readEntries(text), [
      { id: "Hello", translation: "Merhaba" },
      { id: "Wrapped id", translation: "Sarılı" },
    ]);
  });
});

describe("untranslated", () => {
  it("flags an empty line and an English one, but not a listed term or a translation", () => {
    const entries = [
      { id: "Open", translation: "" },
      { id: "Labs", translation: "Labs" },
      { id: "Cron", translation: "Cron" },
      { id: "Save", translation: "Kaydet" },
    ];
    assert.deepEqual(untranslated(entries, new Set(["Cron"])), ["Open", "Labs"]);
  });
});

describe("main", () => {
  it("passes when every entry is translated or listed", () => {
    const { root, sameFile } = tree(entry("Save", "Kaydet") + entry("Cron", "Cron"), ["Cron"]);
    const { code, lines } = main(["--root", root], sameFile);
    assert.equal(code, 0);
    assert.match(lines[0], /^TURKISH: PASS \(2 ids/);
  });

  it("fails naming the ids that are still English", () => {
    const { root, sameFile } = tree(entry("Labs", "Labs") + entry("Open", ""));
    const { code, lines } = main(["--root", root], sameFile);
    assert.equal(code, 2);
    assert.deepEqual(lines.slice(0, 2), ['"Labs"', '"Open"']);
    assert.match(lines.at(-1), /^TURKISH: FAIL \(2 of 2 ids/);
  });

  it("shows the first ids only and counts the rest", () => {
    const body = Array.from({ length: 32 }, (_, i) => entry(`Id ${i}`, "")).join("");
    const { root, sameFile } = tree(body);
    const { lines } = main(["--root", root], sameFile);
    assert.equal(lines.at(-2), "... and 2 more ids");
  });

  it("fails on a missing catalog or a wrong command line", () => {
    assert.equal(main([]).code, 2);
    assert.equal(main(["--root", path.join(os.tmpdir(), "dozo-no-such-tree")]).code, 2);
  });
});

describe("the command", () => {
  const run = (root) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./catalog-turkish.mjs", import.meta.url)), "--root", root],
      { encoding: "utf8" },
    );

  it("exits 0 with the shipped list of kept terms, and 2 for an English entry", () => {
    const kept = run(tree(entry("Cron", "Cron")).root);
    assert.equal(kept.status, 0);
    assert.match(kept.stdout, /^TURKISH: PASS/);
    const english = run(tree(entry("Labs", "Labs")).root);
    assert.equal(english.status, 2);
    assert.match(english.stdout, /TURKISH: FAIL/);
  });
});
