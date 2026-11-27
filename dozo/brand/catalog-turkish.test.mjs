import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bySource, main, readEntries, untranslated } from "./catalog-turkish.mjs";

// The check behind `make qa`'s checks step: nothing in the Turkish catalog is left in English.

const HEADER = 'msgid ""\nmsgstr ""\n"Language: tr\\n"\n\n';
const entry = (id, str, file = "a.tsx") => `#: ${file}\nmsgid "${id}"\nmsgstr "${str}"\n\n`;

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A tree with a Turkish catalog of the given body and the list of terms Turkish keeps. */
function tree(body, same = [], upstreamFiles, replaced = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-turkish-"));
  scratch.push(root);
  const dir = path.join(root, "packages", "i18n", "locales", "tr");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "messages.po"), HEADER + body);
  const sameFile = path.join(root, "same.json");
  fs.writeFileSync(sameFile, JSON.stringify(same));
  const brandFile = path.join(root, "brand.json");
  fs.writeFileSync(brandFile, JSON.stringify({ anchored: replaced.map((replace) => ({ find: "x", replace })) }));
  const listFile = path.join(root, "upstream.txt");
  fs.writeFileSync(listFile, (upstreamFiles ?? []).join("\n"));
  const withList = upstreamFiles ? ["--upstream-files", listFile] : [];
  return { root, sameFile, brandFile, argv: ["--root", root, ...withList], options: { sameFile, brandFile } };
}

describe("readEntries", () => {
  it("joins wrapped lines and skips the header and obsolete entries", () => {
    const text = `${HEADER}${entry("Hello", "Merhaba")}msgid ""\n"Wrapped "\n"id"\nmsgstr ""\n"Sarılı"\n\n#~ msgid "Gone"\n#~ msgstr "Gone"\n`;
    assert.deepEqual(readEntries(text), [
      { id: "Hello", translation: "Merhaba", files: ["a.tsx"] },
      { id: "Wrapped id", translation: "Sarılı", files: [] },
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

describe("bySource", () => {
  const rules = { found: ["Rakazo only"], replaced: ["Dozo copy", "Rakazo only"] };
  const upstream = new Set(["up.tsx"]);
  const split = (entries, sources) => bySource(entries, sources);

  it("calls an entry upstream's only when every file is upstream's and no rule wrote its text", () => {
    const entries = [
      { id: "Plain", files: ["up.tsx"] },
      { id: "Both", files: ["up.tsx", "dozo-a.tsx"] },
      { id: "Dozo copy", files: ["up.tsx"] },
      { id: "Rakazo only", files: ["up.tsx"] },
      { id: "Nowhere", files: [] },
    ];
    assert.deepEqual(split(entries, { upstream, rules }), {
      fork: ["Both", "Dozo copy", "Nowhere"],
      pending: ["Plain", "Rakazo only"],
    });
  });

  it("calls every entry the fork's without a list of upstream files", () => {
    assert.deepEqual(split([{ id: "Plain", files: ["up.tsx"] }], {}), { fork: ["Plain"], pending: [] });
  });
});

describe("main", () => {
  it("passes when every entry is translated or listed", () => {
    const { argv, options } = tree(entry("Save", "Kaydet") + entry("Cron", "Cron"), ["Cron"]);
    const { code, lines } = main(argv, options);
    assert.equal(code, 0);
    assert.match(lines[0], /^TURKISH: PASS \(2 ids/);
  });

  it("fails naming the ids that are still English", () => {
    const { argv, options } = tree(entry("Labs", "Labs") + entry("Open", ""));
    const { code, lines } = main(argv, options);
    assert.equal(code, 2);
    assert.deepEqual(lines.slice(0, 2), ['"Labs"', '"Open"']);
    assert.match(lines.at(-1), /^TURKISH: FAIL \(2 of 2 ids/);
  });

  it("shows the first ids only and counts the rest", () => {
    const body = Array.from({ length: 32 }, (_, i) => entry(`Id ${i}`, "")).join("");
    const { argv, options } = tree(body);
    const { lines } = main(argv, options);
    assert.equal(lines.at(-2), "... and 2 more ids");
  });

  it("passes and counts an English entry that comes from upstream's files", () => {
    const { argv, options } = tree(entry("New", "", "up.tsx") + entry("Save", "Kaydet"), [], ["up.tsx"]);
    const { code, lines } = main(argv, options);
    assert.equal(code, 0);
    assert.deepEqual(lines, ['pending: "New"', "TURKISH: PASS (2 ids; 1 upstream ids pending translation)"]);
  });

  it("fails on an English entry the fork added even when upstream's are pending", () => {
    const body = entry("New", "", "up.tsx") + entry("Mine", "Mine", "dozo-a.tsx");
    const { argv, options } = tree(body, [], ["up.tsx"]);
    const { code, lines } = main(argv, options);
    assert.equal(code, 2);
    assert.deepEqual(lines.slice(0, 2), ['pending: "New"', '"Mine"']);
    assert.match(lines.at(-1), /^TURKISH: FAIL \(1 of 2 ids/);
  });

  it("fails on an entry whose text a brand rule wrote into an upstream file", () => {
    const { argv, options } = tree(entry("Dozo copy", "", "up.tsx"), [], ["up.tsx"], ["<Trans>Dozo copy</Trans>"]);
    assert.equal(main(argv, options).code, 2);
  });

  it("fails on a missing catalog or a wrong command line", () => {
    assert.equal(main([]).code, 2);
    assert.equal(main(["--root", "x", "--bogus", "y"]).code, 2);
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
