import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BINARY_EXT, SHAPES, buildScanner, escapeRe, globToRegExp, loadConfig, phraseRe, rewrite, urlRe } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-brand-test-"));
  temps.push(dir);
  return dir;
}

function tree(files) {
  const root = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const shipped = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));

const URLS = {
  "rakazo.com": "dozo.example",
  "app.rakazo.com": "console.dozo.example",
  "https://apps.apple.com/app/rakazo/id6801531099": "https://dozo.example/get/ios",
  "https://discord.gg/RWwKa2Sn7h": "https://dozo.example/discord",
  "https://play.google.com/store/apps/details?id=com.rakazo.app": "https://dozo.example/get/android",
};

/** A small config next to the fixture, so tests do not depend on the shipped brand.json. */
function configFile(extra = {}) {
  const dir = tempDir();
  const file = path.join(dir, "brand.json");
  const config = {
    from: "Rakazo",
    to: "Dozo",
    variants: { Rakazos: "Dozos" },
    urls: URLS,
    include: ["src/**", "packages/**"],
    exclude: [
      { glob: "**/*.test.*", reason: "tests" },
      { glob: "**/LICENSE*", reason: "license" },
      { glob: "**/node_modules/**", reason: "deps" },
    ],
    keep: [
      { text: "Rakazo.icon", files: ["src/**"], reason: "path" },
      { text: "Rakazo-owned compacted context", files: ["src/**"], reason: "persisted prefix" },
      { text: "fork of Rakazo", files: ["src/**"], reason: "attribution" },
    ],
    allow: { phrases: [{ text: "ghcr.io/elie222/rakazo", files: ["src/**"], reason: "image" }] },
    leak: ["rakazo.com", "elie222/rakazo", "id6801531099", "RWwKa2Sn7h", "com.rakazo.app"],
    anchored: [],
    assets: {},
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

/** No url, keep, allow or literal entries: for tests that run `--strict` on a tiny tree. */
const bare = (extra = {}) => configFile({ urls: {}, variants: {}, keep: [], allow: {}, leak: [], literals: [], ...extra });

const run = (script, root, config, ...more) =>
  spawnSync(process.execPath, [path.join(here, script), "--root", root, "--config", config, ...more], { encoding: "utf8" });
const apply = (root, config, ...more) => run("apply.mjs", root, config, ...more);
const check = (root, config, ...more) => run("check.mjs", root, config, ...more);
const bareRun = (script, ...argv) => spawnSync(process.execPath, [path.join(here, script), ...argv], { encoding: "utf8" });

/** The gate's line scanner without a process: `scan(line, file)` returns the findings. */
function scanner(extra = {}) {
  const { scan, scanPath } = buildScanner(loadConfig(configFile(extra)));
  return { scan: (line, file = "src/a.ts") => scan(file, line), scanPath };
}
const texts = (findings) => findings.map((f) => f.text);

// ---------------------------------------------------------------------------------------------

describe("blanket replace", () => {
  it("rewrites the whole word and its possessive, leaves identifiers alone", () => {
    const root = tree({
      "src/a.ts": [
        'const a = "Welcome to Rakazo";',
        'const b = "Rakazo\'s agents, Rakazo.";',
        "const c = RakazoDesktop + isRakazoContainer;",
        'import x from "@rakazo/core"; // RAKAZO_URL rakazo_app rakazo',
        "const d = `Rakazoにサインイン`;",
      ].join("\n"),
    });
    const res = apply(root, configFile());
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      read(root, "src/a.ts"),
      [
        'const a = "Welcome to Dozo";',
        'const b = "Dozo\'s agents, Dozo.";',
        "const c = RakazoDesktop + isRakazoContainer;",
        'import x from "@rakazo/core"; // RAKAZO_URL rakazo_app rakazo',
        "const d = `Dozoにサインイン`;",
      ].join("\n"),
    );
  });

  it("handles listed word variants such as the German genitive", () => {
    const root = tree({ "src/de.txt": "Rakazos Peers und Rakazo" });
    apply(root, configFile());
    assert.equal(read(root, "src/de.txt"), "Dozos Peers und Dozo");
  });

  it("keeps phrases that code looks up or persists, and still rewrites the rest", () => {
    const root = tree({
      "src/b.ts": [
        'path("assets/Rakazo.icon/x.png");',
        "startsWith(`Rakazo-owned compacted context through`);",
        "`Existing Rakazo-owned summary`;",
        "// fork of Rakazo",
      ].join("\n"),
    });
    apply(root, configFile());
    assert.equal(
      read(root, "src/b.ts"),
      [
        'path("assets/Rakazo.icon/x.png");',
        "startsWith(`Rakazo-owned compacted context through`);",
        "`Existing Dozo-owned summary`;",
        "// fork of Rakazo",
      ].join("\n"),
    );
  });

  it("a keep entry covers only its files and only the whole phrase", () => {
    const root = tree({
      "src/a.ts": "Rakazo.icon Rakazo.icons Rakazo.icon-x Rakazo.icon/Assets",
      "packages/b.ts": "Rakazo.icon",
    });
    assert.equal(apply(root, configFile()).status, 0);
    assert.equal(read(root, "src/a.ts"), "Rakazo.icon Dozo.icons Dozo.icon-x Rakazo.icon/Assets");
    assert.equal(read(root, "packages/b.ts"), "Dozo.icon", "outside the entry's files it is rewritten");
  });

  it("skips excluded paths, files outside include, binaries and node_modules", () => {
    const binary = Buffer.concat([Buffer.from("Rakazo"), Buffer.from([0, 1, 2])]);
    const root = tree({
      "src/a.test.ts": "Rakazo",
      "src/LICENSE": "Rakazo",
      "docs/readme.md": "Rakazo",
      "src/node_modules/x/index.js": "Rakazo",
      "src/live.ts": "Rakazo",
    });
    fs.writeFileSync(path.join(root, "src/img.png"), binary);
    const res = apply(root, configFile());
    assert.equal(res.status, 0, res.stderr);
    for (const rel of ["src/a.test.ts", "src/LICENSE", "docs/readme.md", "src/node_modules/x/index.js"]) {
      assert.equal(read(root, rel), "Rakazo", rel);
    }
    assert.ok(fs.readFileSync(path.join(root, "src/img.png")).equals(binary));
  });

  it("writes `$&` and `$'` in a replacement literally (blanket, url target, anchored rule)", () => {
    const root = tree({ "src/a.ts": "Rakazo rakazo.com B" });
    const config = configFile({
      to: "D$&o$'",
      urls: { "rakazo.com": "d$&.example$'" },
      anchored: [{ file: "src/a.ts", find: "B", replace: "x$&y$'z", reason: "t" }],
    });
    assert.equal(apply(root, config).status, 0);
    assert.equal(read(root, "src/a.ts"), "D$&o$' d$&.example$' x$&y$'z");
  });
});

describe(".po catalogs", () => {
  it("rewrites msgid and msgstr alike so ids still match the rewritten source", () => {
    const root = tree({
      "src/App.tsx": "export const title = t`Welcome to Rakazo`;",
      "packages/i18n/locales/en/messages.po": 'msgid "Welcome to Rakazo"\nmsgstr "Welcome to Rakazo"\n',
      "packages/i18n/locales/de/messages.po":
        'msgid "Welcome to Rakazo"\nmsgstr "Willkommen bei Rakazo"\n\nmsgid "Rakazo\\"s"\nmsgstr "Rakazos"\n',
    });
    apply(root, configFile());
    const source = /t`(.*)`/.exec(read(root, "src/App.tsx"))[1];
    for (const lang of ["en", "de"]) {
      const po = read(root, `packages/i18n/locales/${lang}/messages.po`);
      assert.ok(po.includes(`msgid "${source}"`), `${lang} keeps an entry for the rewritten source`);
      assert.ok(!/\bRakazo\b/.test(po));
    }
    assert.match(read(root, "packages/i18n/locales/de/messages.po"), /msgstr "Willkommen bei Dozo"/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("escaping", () => {
  it("escapeRe makes every regex metacharacter literal", () => {
    for (const c of ".*+?^${}()|[]\\") {
      assert.ok(new RegExp(`^${escapeRe(c)}$`).test(c), c);
      assert.ok(!new RegExp(`^${escapeRe(c)}$`).test("a"), c);
    }
    assert.ok(!new RegExp(escapeRe("a.b")).test("axb"));
    assert.ok(!new RegExp(escapeRe("a?b")).test("b"));
  });

  it("globToRegExp: ** crosses directories, * and ? do not, everything else is literal", () => {
    const m = (glob, text) => globToRegExp(glob).test(text);
    assert.ok(m("**/*.test.*", "a/b/c.test.ts") && m("**/*.test.*", "c.test.ts"));
    assert.ok(!m("src/*.ts", "src/a/b.ts") && m("src/*.ts", "src/a.ts"));
    assert.ok(m("apps/web/**", "apps/web/src/a.ts") && !m("apps/web/**", "apps/webx/a.ts"));
    assert.ok(m("a/**b", "a/x/yb") && m("a/**/b", "a/b") && m("a/**/b", "a/x/y/b"));
    assert.ok(m("a?c", "abc") && !m("a?c", "a/c") && !m("a?c", "ac"));
    assert.ok(m("a.c", "a.c") && !m("a.c", "abc"));
    for (const c of "+^${}()|[]\\") {
      assert.ok(m(`a${c}b`, `a${c}b`), c);
      assert.ok(!m(`a${c}b`, "ab"), c);
    }
    assert.ok(!m("src/a.ts", "xsrc/a.ts") && !m("src/a.ts", "src/a.tsx"), "anchored at both ends");
  });

  it("every shipped url key rewrites to its target, and only that exact key", () => {
    const config = loadConfig();
    for (const [key, target] of Object.entries(config.urls)) {
      assert.equal(rewrite(`x = "${key}";`, config, {}), `x = "${target}";`, key);
      assert.equal(rewrite(`x = "${key.toUpperCase()}";`, config, {}), `x = "${target}";`, `${key} in capitals`);
      for (let i = 0; i < key.length; i++) {
        if (!".?".includes(key[i])) continue;
        // `.` must not be any character, `?` must not make the character before it optional
        const near = key[i] === "." ? key.slice(0, i) + "X" + key.slice(i + 1) : key.slice(0, i - 1) + key.slice(i + 1);
        assert.equal(rewrite(`x = "${near}";`, config, {}), `x = "${near}";`, near);
      }
    }
  });
});

describe("url map", () => {
  const rw = (text, urls = URLS) => rewrite(text, loadConfig(configFile({ urls })), {});

  it("replaces the longest key first", () => {
    assert.equal(rw('"https://app.rakazo.com/x" "https://rakazo.com/docs"'), '"https://console.dozo.example/x" "https://dozo.example/docs"');
  });

  it("a longer key wins over a shorter key that starts the same way", () => {
    const urls = { "rakazo.com": "a.example", "rakazo.com/docs": "docs.example", "rakazo.com/docs/api": "api.example" };
    assert.equal(rw('"rakazo.com/docs/api/x" "rakazo.com/docs/y" "rakazo.com/z"', urls), '"api.example/x" "docs.example/y" "a.example/z"');
  });

  it("replaces a differently capitalised URL with the mapped target exactly", () => {
    const root = tree({ "src/u.ts": '"https://Rakazo.com/x" "APP.RAKAZO.COM/y"' });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(read(root, "src/u.ts"), '"https://dozo.example/x" "console.dozo.example/y"');
    assert.equal(check(root, config).status, 0);
  });

  it("does not eat the start of rakazo.computerOwner, and the gate ignores it", () => {
    const root = tree({ "src/a.ts": 'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://rakazo.com/x"; v = "rakazo.com"' });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(read(root, "src/a.ts"), 'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://dozo.example/x"; v = "dozo.example"');
    assert.equal(check(root, config).status, 0);
  });

  it("a key is a whole host: no glued left side, and a subdomain is not the bare key", () => {
    for (const text of ["getrakazo.com", "status.rakazo.com", "x-rakazo.com", "my.rakazo.com"]) {
      const root = tree({ "src/a.ts": `u = "https://${text}/x";` });
      const config = configFile({ urls: { "rakazo.com": "dozo.example" } });
      assert.equal(apply(root, config).status, 0);
      assert.equal(read(root, "src/a.ts"), `u = "https://${text}/x";`, `${text} is another host: untouched`);
      const res = check(root, config);
      assert.equal(res.status, 2, `${text} stays a leak the gate reports`);
      assert.match(res.stderr, /src\/a\.ts:1: rakazo\.com/);
    }
  });

  it("a key does not match when more query parameters follow, and the gate catches the bare ids", () => {
    const store = "https://play.google.com/store/apps/details?id=com.rakazo.app";
    assert.equal(rw(`"${store}"`), '"https://dozo.example/get/android"');
    for (const rest of ["&hl=en", "=1", "-x", "x"]) assert.equal(rw(`"${store}${rest}"`), `"${store}${rest}"`, rest);
    const cases = {
      "store link with an extra parameter": [`"${store}&hl=en"`, "com.rakazo.app"],
      "localized App Store path": ['"https://apps.apple.com/us/app/rakazo/id6801531099"', "id6801531099"],
      "scheme-less Discord invite": ["see discord.gg/RWwKa2Sn7h", "RWwKa2Sn7h"],
    };
    for (const [name, [line, needle]] of Object.entries(cases)) {
      const root = tree({ "src/a.ts": line });
      const config = configFile();
      assert.equal(apply(root, config).status, 0, name);
      const res = check(root, config);
      assert.equal(res.status, 2, name);
      assert.ok(res.stderr.includes(`src/a.ts:1: ${needle}`), `${name}: ${res.stderr}`);
    }
  });

  it("the old name with another public TLD is a leak, a property of the same name is not", () => {
    const { scan } = scanner();
    for (const tld of ["ai", "app", "io", "net", "org", "dev", "co", "xyz", "me", "cloud", "info", "tech", "tools", "so", "sh", "ly", "gg", "chat", "site", "online", "store"]) {
      assert.deepEqual(texts(scan(`u = "https://www.rakazo.${tld}/x"`)), [`rakazo.${tld}`], tld);
    }
    assert.deepEqual(texts(scan("write to hello@rakazo.ai or HELLO@RAKAZO.AI")), ["rakazo.ai", "RAKAZO.AI"]);
    assert.deepEqual(scan("rakazo.botId rakazo.managed rakazo.test"), []);
  });

  it("the gate reports the new brand followed by a public TLD that no URL target owns", () => {
    const config = configFile();
    for (const text of ['u = "https://Dozo.com/x"', 'u = "app.dozo.io"', "see dozo.AI"]) {
      const res = check(tree({ "src/a.ts": text }), config);
      assert.equal(res.status, 2, text);
      assert.match(res.stderr, /src\/a\.ts:1: .*\(brand domain\)/, text);
    }
    assert.equal(check(tree({ "src/a.ts": 'u = "dozo.example"; v = "console.dozo.example/x"; w = "Dozo.computer"' }), config).status, 0);
  });

  it("the gate flags a URL target glued to the next word", () => {
    const root = tree({ "src/a.ts": 'l = "dozo.exampleputerOwner"' });
    const res = check(root, configFile({ urls: { "rakazo.com": "dozo.example" } }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /url target glued to a word/);
  });

  it("the gate flags a url key that is still in the tree (an unapplied tree)", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan('u = "https://RAKAZO.COM/x"')), ["RAKAZO.COM"]);
    assert.deepEqual(texts(scan("see APP.rakazo.com")), ["APP.rakazo.com"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("anchored rules", () => {
  const rule = (find, replace = "Y", file = "src/a.ts") => ({ file, find, replace, reason: "test" });

  it("fails with exit 2 and writes nothing when the find text is not exactly once", () => {
    const root = tree({ "src/a.ts": "A A B Rakazo", "src/other.ts": "Rakazo" });
    for (const find of ["A", "NOPE"]) {
      const res = apply(root, configFile({ anchored: [rule(find)] }));
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /need exactly 1/);
      assert.equal(read(root, "src/other.ts"), "Rakazo", "nothing is written on failure");
      assert.equal(read(root, "src/a.ts"), "A A B Rakazo");
    }
  });

  it("applies once, then counts as already applied on the next run", () => {
    const root = tree({ "src/a.ts": "A B" });
    const config = configFile({ anchored: [rule("B", "Dozo mark")] });
    const first = apply(root, config);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read(root, "src/a.ts"), "A Dozo mark");
    assert.match(first.stdout, /anchored 1 of 1 applied, 0 already applied/);
    const second = apply(root, config);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /anchored 0 of 1 applied, 1 already applied/);
  });

  it("--strict fails on an already applied rule; a fresh tree passes", () => {
    const config = bare({ anchored: [rule("B", "Dozo mark")] });
    const fresh = tree({ "src/a.ts": "A B" });
    const first = apply(fresh, config, "--strict");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /anchored 1 of 1 applied, 0 already applied/);
    const again = apply(fresh, config, "--strict");
    assert.equal(again.status, 2, again.stderr);
    assert.match(again.stderr, /already applied/);
    assert.equal(read(fresh, "src/a.ts"), "A Dozo mark", "nothing is written on failure");
  });

  it("a short replace elsewhere in the file hides drift without --strict, not with it", () => {
    const config = bare({ anchored: [{ ...rule("B", "undefined,"), reason: "drift" }] });
    const drifted = tree({ "src/a.ts": "x = undefined, y" });
    assert.equal(apply(drifted, config).status, 0, "lenient: counted as already applied");
    const strict = apply(drifted, config, "--strict");
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /drift/);
    assert.match(strict.stderr, /already applied/);
  });

  it("applies when find is once, even though replace already occurs elsewhere in the file", () => {
    const root = tree({ "src/a.ts": "x = undefined, B" });
    const first = apply(root, bare({ anchored: [rule("B", "undefined,")] }), "--strict");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read(root, "src/a.ts"), "x = undefined, undefined,");
  });

  it("names rule and file, and the real count, when find is not exactly once", () => {
    const cases = [
      ["B B", "has 2 matches", false],
      ["A C", "has 0 matches", true],
      ["B B B", "has 3 matches", false],
      ["B B Z", "has 2 matches", false],
      ["Z", "", null], // replace present, find gone: already applied, not an error
    ];
    for (const [text, expected, notThere] of cases) {
      const root = tree({ "src/a.ts": text });
      const res = apply(root, configFile({ anchored: [{ ...rule("B", "Z"), reason: "my-rule" }] }));
      if (notThere === null) {
        assert.equal(res.status, 0, res.stderr);
        continue;
      }
      assert.equal(res.status, 2, text);
      assert.ok(res.stderr.includes(expected), `${text}: ${res.stderr}`);
      assert.match(res.stderr, /my-rule/);
      assert.match(res.stderr, /src\/a\.ts/);
      assert.match(res.stderr, /need exactly 1/);
      assert.equal(res.stderr.includes("replace is not there either"), notThere, text);
      assert.equal(read(root, "src/a.ts"), text);
    }
  });

  it("names the real cause when a find with \\n meets a CRLF file", () => {
    const root = tree({ "src/a.ts": "one\r\ntwo\r\n" });
    const res = apply(root, configFile({ anchored: [rule("one\ntwo", "Z")] }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /CRLF/);
    const lf = tree({ "src/a.ts": "one\ntwo\n" });
    assert.equal(apply(lf, configFile({ anchored: [rule("one\ntwo", "Z")] })).status, 0);
    const crlfOk = tree({ "src/a.ts": "one\r\ntwo\r\n" });
    assert.equal(apply(crlfOk, configFile({ anchored: [rule("one\r\ntwo", "Z")] })).status, 0);
    const missing = apply(tree({ "src/a.ts": "x\r\n" }), configFile({ anchored: [rule("one", "Z")] }));
    assert.doesNotMatch(missing.stderr, /CRLF/, "a find without \\n never blames the line endings");
  });

  it("several rules in one file all apply, in order, and are counted", () => {
    const root = tree({ "src/a.ts": "A B C" });
    const config = bare({ anchored: [rule("A", "1"), rule("B", "2"), rule("C", "3")] });
    const dry = apply(root, config, "--check", "--strict");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /anchored 3 of 3 applied/);
    assert.equal(read(root, "src/a.ts"), "A B C", "--check writes nothing");
    const res = apply(root, config, "--strict");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "src/a.ts"), "1 2 3");
    assert.match(res.stdout, /anchored 3 of 3 applied, 0 already applied/);
  });

  it("rules on several files: each file gets its own rules", () => {
    const root = tree({ "src/a.ts": "A", "src/b.ts": "A", "src/c.ts": "A" });
    const config = bare({ anchored: [rule("A", "1", "src/a.ts"), rule("A", "2", "src/b.ts"), rule("A", "3", "src/c.ts")] });
    assert.equal(apply(root, config, "--strict").status, 0);
    assert.deepEqual(["a", "b", "c"].map((n) => read(root, `src/${n}.ts`)), ["1", "2", "3"]);
  });

  it("a rule on a file outside include applies exactly once and the file gets no blanket rename", () => {
    const root = tree({ "src/a.ts": "x", "docs/guide.md": "Rakazo A and Rakazo" });
    const config = bare({ anchored: [rule("A", "Z", "docs/guide.md")] });
    const first = apply(root, config, "--strict");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read(root, "docs/guide.md"), "Rakazo Z and Rakazo");
    assert.match(first.stdout, /files scanned: 1,/);
    assert.match(first.stdout, /anchored 1 of 1 applied/);
    const again = apply(root, config);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /anchored 0 of 1 applied, 1 already applied/);
  });

  it("rejects at load a rule whose replace contains find, or is empty", () => {
    for (const bad of [rule("B", "B+Dozo"), rule("B", "")]) {
      const root = tree({ "src/a.ts": "A B" });
      const res = apply(root, configFile({ anchored: [bad] }));
      assert.equal(res.status, 2, JSON.stringify(bad));
      assert.match(res.stderr, /empty replace or replace contains find/);
      assert.equal(read(root, "src/a.ts"), "A B", "nothing is written on failure");
    }
  });

  it("fails when a rule redirects to a file the staged tree does not have (every entry of requires)", () => {
    const config = (requires) => bare({ anchored: [{ ...rule("B", "Z"), requires }] });
    const root = tree({ "src/a.ts": "A B", "src/one.ts": "" });
    for (const [requires, missing] of [
      [["src/gone.ts"], "src/gone.ts"],
      [["src/one.ts", "src/gone.ts"], "src/gone.ts"],
      [["src/gone.ts", "src/one.ts"], "src/gone.ts"],
    ]) {
      const res = apply(root, config(requires));
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /dangling redirect/);
      assert.ok(res.stderr.includes(missing));
      assert.equal(read(root, "src/a.ts"), "A B", "nothing is written on failure");
    }
    fs.writeFileSync(path.join(root, "src/two.ts"), "export {};");
    const ok = apply(root, config(["src/one.ts", "src/two.ts"]));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(read(root, "src/a.ts"), "A Z");
  });

  it("fails when the file is missing, is a symlink, or is binary", () => {
    const root = tree({ "src/x.ts": "A" });
    const missing = apply(root, configFile({ anchored: [rule("A", "Z", "src/gone.ts")] }));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /src\/gone\.ts does not exist/);

    fs.symlinkSync("x.ts", path.join(root, "src/link.ts"));
    const link = apply(root, configFile({ anchored: [rule("A", "Z", "src/link.ts")] }));
    assert.equal(link.status, 2);
    assert.match(link.stderr, /src\/link\.ts is a symlink/);
    assert.doesNotMatch(link.stderr, /does not exist/);

    fs.writeFileSync(path.join(root, "src/img.bin"), Buffer.from([65, 0, 1]));
    const bin = apply(root, configFile({ anchored: [rule("A", "Z", "src/img.bin")] }));
    assert.equal(bin.status, 2);
    assert.match(bin.stderr, /src\/img\.bin is binary/);
  });

  it("rejects incomplete rules at load, whatever is missing", () => {
    const complete = { file: "src/a.ts", find: "A", replace: "B", reason: "test" };
    for (const missing of ["file", "find", "replace", "reason"]) {
      const root = tree({ "src/a.ts": "A Rakazo" });
      const { [missing]: _dropped, ...partial } = complete;
      const res = apply(root, configFile({ anchored: [partial] }));
      assert.equal(res.status, 2, missing);
      assert.match(res.stderr, /anchored rule needs file, find, replace and reason/);
      assert.equal(read(root, "src/a.ts"), "A Rakazo");
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("apply safety", () => {
  it("is idempotent, and --strict on the result fails only because of anchored rules", () => {
    const root = tree({ "src/a.ts": "Rakazo https://rakazo.com Rakazos" });
    const config = configFile();
    assert.match(apply(root, config).stdout, /changed: 1/);
    const second = apply(root, config);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /changed: 0/);
    assert.match(second.stdout, /replacements:\n {2}none/);
    assert.equal(apply(root, config, "--strict").status, 2, "strict wants live entries: nothing is left to rewrite");
  });

  it("refuses a tree with .git unless --allow-git", () => {
    const root = tree({ "src/a.ts": "Rakazo", ".git/HEAD": "ref" });
    const config = configFile();
    const refused = apply(root, config);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /\.git/);
    assert.equal(read(root, "src/a.ts"), "Rakazo");
    assert.equal(apply(root, config, "--allow-git").status, 0);
    assert.equal(read(root, "src/a.ts"), "Dozo");
    assert.equal(read(root, ".git/HEAD"), "ref");
  });

  it("--check reports but writes nothing, not even an asset or a temp file", () => {
    const configDir = tempDir();
    fs.mkdirSync(path.join(configDir, "assets"));
    fs.writeFileSync(path.join(configDir, "assets/logo.svg"), "<svg/>");
    const config = path.join(configDir, "brand.json");
    fs.writeFileSync(config, JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets: { "src/public/logo.svg": "logo.svg" } }));
    const root = tree({ "src/a.ts": "Rakazo" });
    const res = apply(root, config, "--check");
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /would change: 2/);
    assert.match(res.stdout, /assets 1 copied/);
    assert.equal(read(root, "src/a.ts"), "Rakazo");
    assert.ok(!fs.existsSync(path.join(root, "src/public")), "no asset, no directory");
    assert.deepEqual(fs.readdirSync(path.join(root, "src")), ["a.ts"]);
  });

  it("--check on a repository root fails on a broken anchor or a missing file and writes nothing", () => {
    const root = tree({ ".git/HEAD": "ref: x", "src/a.ts": "Rakazo A", "src/b.ts": "B" });
    const good = { file: "src/a.ts", find: "A", replace: "Y", reason: "t" };
    const dry = (anchored) => apply(root, configFile({ anchored }), "--check", "--allow-git");
    assert.equal(dry([good]).status, 0);
    for (const rule of [{ ...good, find: "NOPE", replace: "Q" }, { ...good, file: "src/gone.ts" }]) {
      const res = dry([good, rule]);
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /need exactly 1|does not exist/);
    }
    assert.equal(read(root, "src/a.ts"), "Rakazo A");
  });

  it("replaces files through a temp file, keeps their mode, leaves no temp file", () => {
    const root = tree({ "src/run.sh": "#!/bin/sh\necho Rakazo\n", "src/b.ts": "Rakazo" });
    fs.chmodSync(path.join(root, "src/run.sh"), 0o755);
    assert.equal(apply(root, configFile()).status, 0);
    assert.equal(fs.statSync(path.join(root, "src/run.sh")).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.join(root, "src")).sort(), ["b.ts", "run.sh"]);
    assert.equal(read(root, "src/run.sh"), "#!/bin/sh\necho Dozo\n");
  });

  it("an I/O error while writing exits 2 and says the stage is partial", () => {
    const configDir = tempDir();
    fs.mkdirSync(path.join(configDir, "assets"));
    fs.writeFileSync(path.join(configDir, "assets/logo.svg"), "<svg/>");
    const config = path.join(configDir, "brand.json");
    // the asset's parent directory is a regular file: mkdir fails after validation passed
    fs.writeFileSync(config, JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets: { "src/a.ts/logo.svg": "logo.svg" } }));
    const root = tree({ "src/a.ts": "Rakazo" });
    const res = apply(root, config);
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /stage is partial, re-stage/);
    assert.doesNotMatch(res.stderr, /\n\s+at /, "no stack trace");
    assert.equal(read(root, "src/a.ts"), "Rakazo");
  });

  it("non-UTF-8 text fails naming the file, in apply and in the gate, and is never rewritten", () => {
    const root = tree({ "src/ok.ts": "Rakazo" });
    const latin1 = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(" Rakazo")]);
    fs.writeFileSync(path.join(root, "src/latin.txt"), latin1);
    for (const script of [apply, check]) {
      const res = script(root, configFile());
      assert.equal(res.status, 2);
      assert.match(res.stderr, /src\/latin\.txt is not valid UTF-8/);
    }
    assert.ok(fs.readFileSync(path.join(root, "src/latin.txt")).equals(latin1));
    assert.equal(read(root, "src/ok.ts"), "Rakazo");
  });

  it("an unreadable file exits 2 naming it", { skip: process.getuid?.() === 0 }, () => {
    const root = tree({ "src/a.ts": "Rakazo", "src/secret.ts": "x" });
    fs.chmodSync(path.join(root, "src/secret.ts"), 0o000);
    for (const script of [apply, check]) {
      const res = script(root, configFile());
      assert.equal(res.status, 2);
      assert.match(res.stderr, /cannot read src\/secret\.ts/);
    }
    fs.chmodSync(path.join(root, "src/secret.ts"), 0o644);
    assert.equal(read(root, "src/a.ts"), "Rakazo");
  });

  it("keeps a byte order mark, and rewrites UTF-8 outside ASCII", () => {
    const root = tree({ "src/a.ts": "\uFEFFRakazo ✓" });
    assert.equal(apply(root, configFile()).status, 0);
    assert.equal(read(root, "src/a.ts"), "\uFEFFDozo ✓");
  });

  it("an in-scope file with NUL bytes (UTF-16) is reported unless its type is a known binary", () => {
    const utf16 = Buffer.from("\uFEFFRakazo\n", "utf16le");
    const root = tree({ "src/ok.ts": "Rakazo" });
    fs.writeFileSync(path.join(root, "src/notes.txt"), utf16);
    for (const script of [apply, check]) {
      const res = script(root, configFile());
      assert.equal(res.status, 2, script.name);
      assert.match(res.stderr, /src\/notes\.txt: binary content \(NUL byte\)/);
    }
    assert.ok(fs.readFileSync(path.join(root, "src/notes.txt")).equals(utf16));
    fs.rmSync(path.join(root, "src/notes.txt"));
    fs.writeFileSync(path.join(root, "src/font.woff2"), utf16);
    assert.equal(apply(root, configFile({ allow: { images: [{ glob: "src/font.woff2", reason: "r" }] } })).status, 0);
  });

  it("zero files in scope is a failure, in apply and in the gate", () => {
    const root = tree({ "docs/a.md": "Rakazo" });
    const res = apply(root, configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no file is in scope/);
    const gate = check(root, configFile());
    assert.equal(gate.status, 2);
    assert.match(gate.stderr, /0 files scanned/);
    assert.doesNotMatch(gate.stdout, /clean/);
  });
});

describe("assets", () => {
  const setup = () => {
    const configDir = tempDir();
    fs.mkdirSync(path.join(configDir, "assets"));
    fs.writeFileSync(path.join(configDir, "assets/logo.svg"), "<svg/>");
    fs.mkdirSync(path.join(configDir, "assets/dir"));
    const config = path.join(configDir, "brand.json");
    const write = (assets) => fs.writeFileSync(config, JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets }));
    return { config, write };
  };

  it("copies a mapped file once, and rejects a missing or non-file source, an escaping path, a directory destination", () => {
    const { config, write } = setup();
    const root = tree({ "src/a.ts": "x" });

    write({ "public/logo.svg": "logo.svg" });
    const first = apply(root, config);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read(root, "public/logo.svg"), "<svg/>");
    assert.match(first.stdout, /assets 1 copied/);
    assert.match(apply(root, config).stdout, /assets 0 copied/);

    write({ "public/x.svg": "missing.svg" });
    const missing = apply(root, config);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /does not exist or is not a file/);

    write({ "public/x.svg": "dir" });
    const dir = apply(root, config);
    assert.equal(dir.status, 2, "a directory as the source is a rule failure, not a crash");
    assert.match(dir.stderr, /not a file/);

    write({ "../escape.svg": "logo.svg" });
    assert.match(apply(root, config).stderr, /destination escapes the root/);
    write({ "public/x.svg": "../brand.json" });
    assert.match(apply(root, config).stderr, /must stay under assets/);
    const sibling = path.join(path.dirname(config), "assets2");
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "x.svg"), "<svg/>");
    for (const source of [path.join(sibling, "x.svg"), "/etc/hostname"]) {
      write({ "public/x.svg": source });
      const res = apply(root, config);
      assert.equal(res.status, 2, source);
      assert.match(res.stderr, /must stay under assets/, "an absolute source, or a sibling that shares the prefix, is outside assets/");
    }

    fs.mkdirSync(path.join(root, "public/taken"));
    write({ "public/taken": "logo.svg" });
    const taken = apply(root, config);
    assert.equal(taken.status, 2);
    assert.match(taken.stderr, /destination exists and is not a file/);
  });

  it("a destination in a sibling directory that shares the root's name prefix escapes the root", () => {
    const { config, write } = setup();
    const root = tree({ "src/a.ts": "x" });
    const sibling = `${root}2`;
    fs.mkdirSync(sibling);
    temps.push(sibling);
    write({ [`../${path.basename(sibling)}/logo.svg`]: "logo.svg" });
    const res = apply(root, config);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /destination escapes the root/);
    assert.deepEqual(fs.readdirSync(sibling), []);
  });
});

// ---------------------------------------------------------------------------------------------

describe("leak gate", () => {
  it("passes on a clean tree and on identifiers, kept phrases and allow-listed text", () => {
    const root = tree({
      "src/a.ts": [
        'import "@rakazo/core"; const rakazo_app = RakazoDesktop; // RAKAZO_URL',
        'path("Rakazo.icon"); // fork of Rakazo',
        'const image = "ghcr.io/elie222/rakazo/computer:edge";',
        "const home = `/home/rakazo`;",
      ].join("\n"),
      "src/a.test.ts": "Rakazo rakazo.com",
      "CHANGELOG.md": "Rakazo",
    });
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "leak gate clean: 1 files scanned\n");
  });

  it("fails with path:line: match for the old name, hosts and repo, one finding per leak", () => {
    const root = tree({
      "src/a.ts": 'ok\nconst t = "Sign in to Rakazo";\n"https://Rakazo.com/x" github.com/elie222/rakazo\nRakazos',
    });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    const lines = res.stderr.trim().split("\n");
    assert.deepEqual(lines, [
      "src/a.ts:2: Rakazo",
      "src/a.ts:3: Rakazo.com",
      "src/a.ts:3: elie222/rakazo",
      "src/a.ts:4: Rakazos",
      "4 leak(s) of the old brand in 1 files scanned",
    ]);
  });

  it("caps the list at 50 lines and says so only when it capped", () => {
    const capped = check(tree({ "src/a.ts": Array.from({ length: 70 }, () => "Rakazo").join("\n") }), configFile());
    assert.equal(capped.status, 2);
    const lines = capped.stderr.trim().split("\n");
    assert.equal(lines.length, 51);
    assert.match(lines.at(-1), /^70 leak\(s\) of the old brand in 1 files scanned \(list capped at 50\)$/);
    const exact = check(tree({ "src/a.ts": Array.from({ length: 50 }, () => "Rakazo").join("\n") }), configFile());
    assert.equal(exact.stderr.trim().split("\n").length, 51);
    assert.doesNotMatch(exact.stderr, /capped/);
  });

  it("counts the files it scanned, and says when launch checks are on", () => {
    const root = tree({ "src/a.ts": "x", "src/b.ts": "y", "packages/c.ts": "z", "docs/d.md": "Rakazo", "src/e.test.ts": "Rakazo" });
    assert.equal(check(root, configFile()).stdout, "leak gate clean: 3 files scanned\n");
    assert.equal(check(root, configFile(), "--launch").stdout, "leak gate clean: 3 files scanned (launch checks on)\n");
    const dirty = check(tree({ "src/a.ts": "Rakazo", "src/b.ts": "x" }), configFile());
    assert.match(dirty.stderr, /^src\/a\.ts:1: Rakazo\n1 leak\(s\) of the old brand in 2 files scanned\n$/);
  });

  it("is clean right after apply on a tree with new upstream strings, and fails when one is added later", () => {
    const root = tree({ "src/a.ts": 'const a = "Rakazo"; const u = "https://rakazo.com";' });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(check(root, config).status, 0);
    fs.appendFileSync(path.join(root, "src/a.ts"), '\nconst later = "New Rakazo copy";\n');
    const res = check(root, config);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/a\.ts:2: Rakazo/);
  });

  it("reports a literal that was not applied once per line", () => {
    const literals = [{ find: "/home/rakazo", replace: "/home/dozo", reason: "path" }];
    const res = check(tree({ "src/a.ts": 'cwd = "/home/rakazo"; other = "/home/rakazo/x"' }), configFile({ literals }));
    assert.equal(res.status, 2);
    assert.equal(res.stderr.match(/literal rule not applied/g).length, 1);
    const scoped = [{ find: "/home/rakazo", replace: "/home/dozo", files: ["src/u.sh"], reason: "one file" }];
    assert.equal(check(tree({ "src/a.ts": "x = '/home/rakazo'" }), configFile({ literals: scoped })).status, 0, "not applicable to this file");
    assert.equal(check(tree({ "src/u.sh": "x = '/home/rakazo'" }), configFile({ literals: scoped })).status, 2);
  });

  it("a finding that sits inside an earlier one is the same leak", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan('u = "https://Rakazo.com/x"')), ["Rakazo.com"]);
    assert.deepEqual(texts(scan("Rakazo Rakazo.com")), ["Rakazo", "Rakazo.com"]);
    const lines = scan("a RAKAZO.COM b").map((f) => f.start);
    assert.deepEqual(lines, [2]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("every occurrence of the old name is a leak", () => {
  const leaks = {
    "bullet": "- Ask rakazo to summarise this",
    "numbered list": "1. Tell rakazo what you need",
    "wrapped prompt line starting with a keyword": "if the user asks rakazo to stop, stop",
    "code punctuation in the line": "You are rakazo, helping ${user}.",
    "assignment in the line": "const greeting = `Hello from rakazo`; x = 1;",
    "one word and a period": "rakazo.",
    "one word": "rakazo",
    "quoted word": '"rakazo"',
    "hyphen compound": "built with rakazo-powered tools",
    "hyphen compound after a quote": 'label: "rakazo-powered"',
    "hashtag": "share it #rakazo",
    "possessive": "rakazo's agents",
    "all caps": "RAKAZO IS UPDATING",
    "all caps sentence": "<p>Welcome to RAKAZO</p>",
    "capitalised": "Welcome to Rakazo",
    "handle": "Follow @rakazo for news",
    "text between tags": "<p>Welcome to rakazo</p>",
    "tag with expression": "<p>Welcome to rakazo, {name}</p>",
    "alt attribute": '<img alt="rakazo logo" src={x} />',
    "aria-label": '<button aria-label="Open rakazo menu" />',
    "title": "<a title='About rakazo' />",
    "placeholder": '<input placeholder="Ask rakazo anything" />',
    "prose string": 'const m = "Thanks for trying rakazo, the team";',
    "template string": "const m = `the rakazo team (${n})`;",
    "download name": "`rakazo-export-${d}.zip`",
    "client name": '{ name: "rakazo" }',
    "quoted PascalCase": 'operationName: "RakazoIntrospection"',
    ".po entry": 'msgid "About rakazo"',
    "domain with a TLD": "https://rakazo.ai",
    "email address": "write to hello@rakazo.ai",
    "comment": "// the rakazo container reuses this file",
    "block comment": "/* rakazo is a name here */",
    "founder name": "Signed, Elie",
    "PascalCase glued in prose": "<p>Ask RakazoBot for help</p>",
    "PascalCase glued at the end of a sentence": "Ask RakazoBot.",
    "camelCase glued in prose": "Ask rakazoBot to help you",
    "path-like word that is no listed shape": "see /srv/rakazo/data",
    "hyphen word that is no listed stem": "rakazo-labs",
    "property-looking word with a sentence stop": "rakazo. Next sentence",
    "colon with a space": "rakazo: a name",
  };
  for (const [name, line] of Object.entries(leaks)) {
    it(`flags ${name}`, () => {
      const { scan } = scanner({ leakWords: ["Elie"] });
      assert.ok(scan(line).length >= 1, line);
    });
  }

  it("names the file and line, the right one of a longer file", () => {
    const res = check(tree({ "src/a.tsx": "const a = 1;\nconst b = 2;\n<p>Hi rakazo</p>\n" }), configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/a\.tsx:3: rakazo\n/);
  });

  it("flags the founder's first name as a whole word only", () => {
    const { scan } = scanner({ leakWords: ["Elie"] });
    assert.deepEqual(texts(scan("<Text>Elie</Text>")), ["Elie"]);
    assert.deepEqual(scan("Elies elie ElieX"), []);
  });

  it("flags social profile links of every host and capitalisation, look-alike hosts too", () => {
    const hosts = [
      "x.com/", "twitter.com/", "github.com/", "facebook.com/", "fb.com/", "instagram.com/", "t.me/", "tiktok.com/@",
      "threads.net/@", "bsky.app/profile/", "linkedin.com/company/", "linkedin.com/in/", "linkedin.com/showcase/",
      "youtube.com/@", "youtube.com/c/", "youtube.com/user/", "youtube.com/channel/", "medium.com/@", "medium.com/",
      "reddit.com/r/", "reddit.com/user/", "reddit.com/u/", "discord.gg/", "discord.com/invite/", "www.x.com/", "mobile.twitter.com/",
      "notgithub.com/",
    ];
    const { scan } = scanner();
    for (const host of hosts) {
      for (const handle of ["rakazo", "Rakazo", "RAKAZO", "rakazo_hq", "rakazoHQ"]) {
        assert.ok(scan(`<a href="https://${host}${handle}">`).length >= 1, `${host}${handle}`);
      }
    }
  });

  it("a PascalCase identifier is code unless it stands between plain words", () => {
    const { scan } = scanner();
    for (const code of [
      "export type RakazoDesktop = {",
      "  desktop: RakazoDesktop | undefined,",
      "import type { RakazoDesktop, UserDeviceSummary } from './x';",
      "const rakazoScreen = 1; const RakazoDesktop = 2; const isRakazoContainer = 3;",
      "  rakazoUserId: input.userId,",
      "`<body><script>RakazoPage.mount(${boot})</script></body>`",
      "window.RakazoPage = { mount };",
      "if (host.rakazoDesktop) return true;",
    ]) {
      assert.deepEqual(scan(code), [], code);
    }
    for (const prose of ["Ask RakazoBot to help", "ask rakazoBot to help", "Hello RakazoBot, welcome", "Ask RakazoBot", "Ask RakazoBot.", "say\tRakazoBot to"]) {
      assert.equal(scan(prose).length, 1, prose);
    }
    assert.match(scan("Ask RakazoBot to help")[0].label, /glued into prose/);
  });
});

// One row per identifier shape: what passes (positive), what is still a leak although it looks
// alike (negative), and which samples must stop passing when a letter is glued to the left or right.
const SHAPE_CASES = {
  "package-scope": {
    yes: ['import x from "@rakazo/core";', 'import { y } from "@rakazo/ui-web/button";'],
    no: ["Follow @rakazo for news", "mail me at x@rakazo.ai"],
  },
  "env-name": {
    yes: ["process.env.RAKAZO_HOST", "const d = __RAKAZO_VERSION__;", "SLACK_RAKAZO_BOT_ID", "$RAKAZO_HOME/x"],
    no: ["RAKAZO IS UPDATING", "RAKAZO-X", "XRAKAZO_X"],
    left: ["RAKAZO_HOST"],
  },
  "snake-name": {
    yes: ["rakazo_credit_cents", "__rakazo_catalog__", "lib.rakazo_xcapture_open(x)"],
    no: ["rakazo cents", "rakazo-cents"],
    left: ["rakazo_credit_cents"],
    no2: ["https://github.com/rakazo_hq", "@rakazo_hq"],
  },
  "camel-name": {
    yes: ["RakazoDesktop", "rakazoScreen", "isRakazoContainer", "window.__rakazoApp", "rakazoUserId: 1"],
    no: ["Rakazo Desktop", "rakazo desktop", "Rakazos", "https://github.com/rakazoHQ", "follow @RakazoHQ"],
    left: ["RakazoDesktop", "rakazoScreen"],
  },
  "template-name": {
    yes: ["`rakazo-${randomUUID()}`", 'rm -rf "rakazo-$dir"'],
    no: ["rakazo-powered", "rakazo-{id}"],
    left: ["rakazo-${id}"],
  },
  "namespaced-key": {
    yes: ['"rakazo:thread:1"', 'new URL("rakazo://open")', "rakazo:$id"],
    no: ['{ rakazo: "computer" }', "rakazo: a name", "rakazo:"],
    left: ["rakazo:thread:1"],
  },
  "dotted-key": {
    yes: ['localStorage.getItem("rakazo.uiAppearance")', "rakazo.botId", "span.setAttribute('rakazo.run.id', id)"],
    no: ["Welcome to rakazo. Next", "rakazo.", "rakazo.9"],
    left: ["rakazo.botId"],
  },
  "header": {
    yes: ['"x-rakazo-space-id"', "X-Rakazo-Space-Id: 1", 'startsWith("x-rakazo-")'],
    no: ["xx-rakazo-id", "my-x-rakazo-id", "x-rakazo"],
  },
  "data-attribute": {
    yes: ['<div data-rakazo-surface="auth" />', 'root.setAttribute("data-rakazo-screen-error", "")'],
    no: ["mydata-rakazo-x", "data-rakazo=1", "data-rakazo"],
  },
  "css-name": {
    yes: [".rakazo-logo-avatar { }", "rakazo-organic-avatar-body-idle", "--rakazo-organic-path: 1", "animation: rakazo-avatar-spin 1s", "rakazo-group-avatar", "rakazo-bot-avatar-ring"],
    no: ["rakazo-logo-powered", "rakazo-avatar-glow", "rakazo-bot-powered"],
    left: ["rakazo-logo-avatar", "rakazo-organic-float"],
  },
  "dom-event": {
    yes: ['type === "rakazo-page:copy"', 'type: "rakazo-app:host"', '"rakazo-mention:"', '"rakazo-mcp-signin:"', "rakazo-save:$id"],
    no: ["rakazo-page copy", "rakazo-pages:x", "rakazo-page"],
    left: ["rakazo-page:copy"],
  },
  "binary-name": {
    yes: ["exec rakazo-browser --flag", "rakazo-page-browser", "rakazo-focus-or-launch", "rakazo-computer-control", "rakazo-local-bin.sh", "ld librakazo-xcapture.so", "rakazo-terminal.py"],
    no: ["rakazo-browsers", "rakazo-computers", "rakazo-homes", "xrakazo-browser"],
    left: ["rakazo-browser", "rakazo-proxy"],
    right: ["rakazo-browser", "rakazo-home", "rakazo-xcapture"],
  },
  "service-name": {
    yes: ['serviceName: "rakazo-api"', "rakazo-api-jobs", '"rakazo-worker"', "Project-Id-Version: rakazo-web\\n", "rakazo-sandbox-supervisor", "rakazo-prod"],
    no: ["rakazo-apis", "rakazo-weblog", "rakazo-workers"],
    left: ["rakazo-api"],
    right: ["rakazo-api", "rakazo-worker"],
  },
  "persisted-key": {
    yes: ['name: "rakazo-instance-theme"', '"rakazo-account-export"', "rakazo-turn-document", '"rakazo-slack-install"', 'user.rakazo-bot-id'],
    no: ["rakazo-instance-themes", "rakazo-historyx", "rakazo-accounts"],
    left: ["rakazo-oauth"],
    right: ["rakazo-oauth", "rakazo-history"],
  },
  "name-prefix": {
    yes: ['"rakazo-shell-"', "`rakazo-snapshot-${id}`", "/^rakazo-bot-[a-z]+$/", 'f"rakazo-ab-{uid}"', 'mkdtemp(join(tmpdir(), "rakazo-mcp-"))'],
    no: ["rakazo-shell-powered", "rakazo-bot-powered", "rakazo-mcp-x"],
    left: ['rakazo-shell-"'],
  },
  "process-marker": {
    yes: ['"rakazo-background-launch $id"', "-i rakazo-c+", "rakazo-cprobe", '"rakazo-write"', "rakazo-coding-agent-probe", "rakazo-cancel-run-work", "rakazo-egress-probe", "rakazo-background-idle"],
    no: ["rakazo-cat", "rakazo-writes", "rakazo-background-launcher", "rakazo-cprobes"],
    left: ["rakazo-write", "rakazo-c"],
    right: ["rakazo-write", "rakazo-c", "rakazo-cprobe"],
  },
  "memory-entity": {
    yes: ["`rakazo-space/${spaceId}`", "`rakazo-bot/${label}--${botId}`"],
    no: ["rakazo-space/home", "rakazo-bot/hello"],
  },
  "image-name": {
    yes: ['"rakazo/computer:local"', "/^rakazo\\/computer(:[\\w][\\w.-]*)?$/", "image rakazo/computer."],
    no: ["rakazo/computers", "github.com/x/rakazo/computer", "rakazo/computer-x"],
    left: ["rakazo/computer"],
  },
  "kdf-context": {
    yes: ['"rakazo/content/v1"', '"rakazo/content-master-key/v1"', '"rakazo/search/v1"', "`rakazo/space-key/v1\\0${id}`"],
    no: ["rakazo/content/v2", "rakazo/other/v1", "my-rakazo/search/v1"],
    left: ["rakazo/search/v1"],
  },
  "hidden-name": {
    yes: ["${HOME}/.rakazo-command-env", '".rakazo-executables.json"', 'relative === ".rakazo"', "`${root}/.rakazo/screens.json`"],
    no: [".rakazo-notes", "x.rakazo-command-env", ".rakazo "],
    left: [".rakazo-command-env"],
  },
  "fs-path": {
    yes: ["/tmp/rakazo/x.log", "/usr/local/bin/rakazo-x", "/home/desktop/rakazo-home", "/usr/local/lib/librakazo-xcapture.so", "/etc/brave/policies/managed/rakazo.json", "/tmp/rakazo/rakazo-terminal.py", "/home/user/.rakazo-command-env"],
    no: ["/srv/rakazo/x", "github.com/tmp/rakazo", "see /tmp/ rakazo"],
  },
  "shell-path": {
    yes: ['cat "$dir/rakazo-proxy.json"', "~/rakazo-home", "./rakazo-browser", "$directory/.rakazo-write.XXXXXX", "# --user-data-dir=.../rakazo-browser"],
    no: ["github.com/rakazo-labs", "a/rakazo-x"],
  },
  "windows-path": {
    yes: ["`${profile}\\\\rakazo\\\\.runs\\\\${id}`"],
    no: ["C:\\rakazo ", "\\\\rakazo ", "rakazo\\\\x"],
  },
  "dev-database": {
    yes: ['"postgres://rakazo:rakazo@127.0.0.1:5433/rakazo"'],
    no: ['"postgres://rakazo:secret@127.0.0.1:5433/rakazo"', "postgres://user:rakazo@host/other"],
  },
};

describe("identifier shapes", () => {
  it("every shape has a row of samples with a positive and a negative, and every row is a shape", () => {
    assert.deepEqual(Object.keys(SHAPE_CASES).sort(), SHAPES.map((s) => s.name).sort());
    for (const shape of SHAPES) {
      assert.ok(shape.reason && shape.reason.length > 10, `${shape.name} has a reason`);
      assert.ok(shape.re.global, `${shape.name} is global`);
      assert.ok(SHAPE_CASES[shape.name].yes.length >= 1 && SHAPE_CASES[shape.name].no.length >= 1, shape.name);
    }
    assert.equal(new Set(SHAPES.map((s) => s.name)).size, SHAPES.length);
  });

  for (const [name, row] of Object.entries(SHAPE_CASES)) {
    it(`${name}: positives pass, look-alikes and glued forms are leaks`, () => {
      const { scan } = scanner();
      for (const line of row.yes) assert.deepEqual(scan(line), [], `${name} should pass: ${line}`);
      for (const line of [...row.no, ...(row.no2 ?? [])]) assert.ok(scan(line).length >= 1, `${name} should be a leak: ${line}`);
      for (const line of row.left ?? []) {
        for (const glue of ["Q", "7"]) assert.ok(scan(`${glue}${line}`).length >= 1, `${name} must not match glued on the left: ${glue}${line}`);
      }
      for (const line of row.right ?? []) {
        for (const glue of ["x", "Z", "9"]) assert.ok(scan(`${line}${glue}`).length >= 1, `${name} must not match glued on the right: ${line}${glue}`);
      }
    });
  }

  it("a shape matches only the token that holds the name: the rest of the line is still checked", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan("@rakazo/core and rakazo")), ["rakazo"]);
    assert.deepEqual(texts(scan("RAKAZO_HOST Rakazo")), ["Rakazo"]);
    // one shape must not destroy another one's context: this URL needs `rakazo:` and `//rakazo:` together
    assert.deepEqual(scan('"postgres://rakazo:rakazo@127.0.0.1:5433/rakazo"'), []);
  });
});

// ---------------------------------------------------------------------------------------------

describe("reviewed phrases", () => {
  it("allow.phrases silences one reviewed occurrence, in its files only, as a whole", () => {
    const allow = { phrases: [{ text: 'update("rakazo rls bypass")', files: ["src/db.ts"], reason: "hash input" }] };
    const config = configFile({ allow });
    assert.equal(check(tree({ "src/db.ts": 'h.update("rakazo rls bypass");' }), config).status, 0);
    const elsewhere = check(tree({ "src/other.ts": 'h.update("rakazo rls bypass");' }), config);
    assert.equal(elsewhere.status, 2, "outside its files the same text is a leak");
  });

  it("a phrase does not cover a longer word or a look-alike image", () => {
    const { scan } = scanner();
    assert.deepEqual(scan("image: ghcr.io/elie222/rakazo/computer:edge"), []);
    assert.deepEqual(scan("image: ghcr.io/elie222/rakazo"), []);
    assert.ok(scan("image: ghcr.io/elie222/rakazo-evil/img").length >= 1);
    assert.ok(scan("image: ghcr.io/elie222/rakazos").length >= 1);
    assert.ok(scan("x ghcr.io/elie222/rakazo2").length >= 1);
    assert.ok(scan("Rakazo.icon").length === 0 && scan("Rakazo.apps").length >= 1);
    assert.ok(scan("Rakazo.icons").length >= 1 && scan("Rakazo.icon-x").length >= 1);
    assert.ok(scan("xghcr.io/elie222/rakazo").length >= 1, "no glued left side");
  });

  it("phraseRe: boundaries only next to word characters, and only when the phrase ends or starts with one", () => {
    const ends = phraseRe("a.b");
    assert.ok(ends.test("x a.b y") && (ends.lastIndex = 0, !ends.test("a.bc")) && (ends.lastIndex = 0, !ends.test("a.b-c")) && (ends.lastIndex = 0, !ends.test("xa.b")));
    const dotted = phraseRe(".update(x)");
    assert.ok(dotted.test("h.update(x)") && (dotted.lastIndex = 0, dotted.test(".update(x)y")), "no boundary at a non-word edge");
  });

  it("allow.text silences a text in one file only, and the rest of that file is still checked", () => {
    const allow = { text: [{ file: "src/a.ts", text: 'originator: "rakazo"', reason: "vendor" }] };
    const config = configFile({ allow });
    assert.equal(check(tree({ "src/a.ts": 'const h = { originator: "rakazo" };' }), config).status, 0);
    assert.equal(check(tree({ "src/b.ts": 'const h = { originator: "rakazo" };' }), config).status, 2, "another file");
    assert.equal(check(tree({ "src/a.ts": '<p>Welcome to rakazo</p>' }), config).status, 2, "other text in the same file");
    assert.equal(check(tree({ "src/a.ts": 'originator: "rakazo" + "rakazo"' }), config).status, 2, "a second occurrence outside the text");
  });

  it("the shipped allow.text entries cover their text in their file and nothing else there or elsewhere", () => {
    const light = { ...shipped, anchored: [], assets: {} };
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify(light));
    const { scan } = buildScanner(loadConfig(file));
    assert.ok(shipped.allow.text.length > 0);
    for (const entry of shipped.allow.text) {
      assert.deepEqual(scan(entry.file, entry.text), [], `${entry.file}: ${entry.text}`);
      assert.ok(scan(entry.file, `<p>Welcome to rakazo</p> ${entry.text}`).length >= 1, `${entry.file}: other text in the file is checked`);
      assert.ok(scan("packages/other.ts", entry.text).length >= 1, `${entry.text}: reviewed in ${entry.file} only, and not already covered by a shape`);
    }
  });
});

describe("file and directory names", () => {
  it("a name that carries the old brand is reported once per path, unless reviewed in allow.paths", () => {
    const root = tree({ "src/rakazo-x.ts": "x", "src/Rakazo.icon/a.ts": "x", "src/Rakazo.icon/b.ts": "x", "docs/rakazo.md": "x", "src/ok.ts": "x" });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/Rakazo\.icon: file or directory name carries the old brand/m);
    assert.match(res.stderr, /^src\/rakazo-x\.ts: file or directory name/m);
    assert.equal(res.stderr.match(/Rakazo\.icon:/g).length, 1, "the directory once, not once per file");
    assert.doesNotMatch(res.stderr, /docs\/rakazo\.md/, "outside the file set");
    assert.match(res.stderr, /^2 leak\(s\)/m);
    const allow = { paths: [{ glob: "src/rakazo-*", reason: "bin" }, { glob: "src/Rakazo.icon", reason: "icon bundle" }] };
    assert.equal(check(root, configFile({ allow })).status, 0);
    const onlyDir = check(root, configFile({ allow: { paths: [{ glob: "src/Rakazo.icon", reason: "icon bundle" }] } }));
    assert.match(onlyDir.stderr, /src\/rakazo-x\.ts/);
    assert.doesNotMatch(onlyDir.stderr, /Rakazo\.icon:/);
  });

  it("a nested file under a reviewed directory is not reported, a brand-named file inside it is", () => {
    const root = tree({ "src/Rakazo.icon/Assets/rakazo-x.ts": "x" });
    const res = check(root, configFile({ allow: { paths: [{ glob: "src/Rakazo.icon", reason: "bundle" }] } }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/Rakazo\.icon\/Assets\/rakazo-x\.ts:/m);
  });
});

describe("images and binaries in the gate", () => {
  const mk = () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "ours.png"), Buffer.from([1, 0, 2, 3]));
    return { file: path.join(dir, "brand.json") };
  };
  const base = { from: "Rakazo", to: "Dozo", include: ["apps/**"], assets: { "apps/web/public/i.png": "ours.png" } };
  const put = (root, rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };

  it("apply copies the asset and the gate accepts it; an upstream file fails the gate", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify(base));
    const root = tree({ "apps/web/a.ts": "x" });
    put(root, "apps/web/public/i.png", Buffer.from([9, 0, 9]));
    assert.equal(check(root, file).status, 2);
    assert.equal(apply(root, file).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, "apps/web/public/i.png")), Buffer.from([1, 0, 2, 3]));
    assert.equal(check(root, file).status, 0);
  });

  it("an unmapped image fails the gate until it is reviewed in allow.images, for every image type", () => {
    const { file } = mk();
    const types = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tif", "tiff", "heic", "jfif", "jp2", "apng", "pdf", "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "lottie", "riv", "PNG"];
    for (const ext of types) {
      fs.writeFileSync(file, JSON.stringify(base));
      const root = tree({ "apps/web/a.ts": "x" });
      put(root, "apps/web/public/i.png", Buffer.from([1, 0, 2, 3]));
      put(root, `apps/web/public/new.${ext}`, Buffer.from([7, 0]));
      const res = check(root, file);
      assert.equal(res.status, 2, ext);
      assert.match(res.stderr, new RegExp(`new\\.${ext}: image neither mapped`), ext);
      fs.writeFileSync(file, JSON.stringify({ ...base, allow: { images: [{ glob: `apps/web/public/new.${ext}`, reason: "r" }] } }));
      assert.equal(check(root, file).status, 0, ext);
    }
    assert.ok(BINARY_EXT.test("a.TIFF"));
    assert.ok(!BINARY_EXT.test("a.png.txt") && !BINARY_EXT.test("png"));
  });

  it("scans the text of an svg that is reviewed but not mapped", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify({ ...base, allow: { images: [{ glob: "apps/web/public/logo.svg", reason: "r" }] } }));
    const root = tree({});
    put(root, "apps/web/public/i.png", Buffer.from([1, 0, 2, 3]));
    put(root, "apps/web/public/logo.svg", "<svg><title>Rakazo</title></svg>");
    const res = check(root, file);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /logo\.svg:1: Rakazo/);
    put(root, "apps/web/public/logo.svg", "<svg><title>Dozo</title></svg>");
    assert.equal(check(root, file).status, 0);
  });
});

describe("launch gate", () => {
  it("flags the url targets and upstream image names only with --launch, and only where they apply", () => {
    const root = tree({ "src/a.ts": 'u = "https://dozo.example/x"; r = "github.com/OWNER/dozo"; i = "ghcr.io/elie222/rakazo/app"' });
    const config = configFile({ urls: { "rakazo.com": "dozo.example", "github.com/elie222/rakazo": "github.com/OWNER/dozo" } });
    assert.equal(check(root, config).status, 0);
    const res = check(root, config, "--launch");
    assert.equal(res.status, 2);
    for (const text of ["dozo.example", "github.com/OWNER/dozo", "ghcr.io/elie222/rakazo"]) assert.ok(res.stderr.includes(`src/a.ts:1: ${text} (launch placeholder)`), text);
    const other = check(tree({ "packages/a.ts": 'i = "ghcr.io/elie222/rakazo/app"' }), config, "--launch");
    assert.equal(other.status, 2);
    assert.match(other.stderr, /packages\/a\.ts:1: elie222\/rakazo\n/, "outside the phrase's files it is a plain leak, not a launch placeholder");
    assert.doesNotMatch(other.stderr, /launch placeholder/);
  });

  it("placeholders come from the url targets, whatever they are", () => {
    const config = configFile({ urls: { "rakazo.com": "acme.example" } });
    const root = tree({ "src/a.ts": 'u = "acme.example"; v = "dozo.example"' });
    const res = check(root, config, "--launch");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/a\.ts:1: acme\.example \(launch placeholder\)/);
    assert.doesNotMatch(res.stderr, /dozo\.example/);
    const none = check(tree({ "src/a.ts": 'v = "dozo.example"' }), configFile({ urls: {} }), "--launch");
    assert.equal(none.status, 0, none.stderr);
  });

  it("--launch skips an allow.phrases entry marked permanent and flags the rest", () => {
    const allow = {
      phrases: [
        { text: "ghcr.io/elie222/rakazo", files: ["src/**"], reason: "image" },
        { text: 'update("rakazo rls bypass")', files: ["src/**"], reason: "hash input", permanent: true },
      ],
    };
    const config = configFile({ allow, urls: {} });
    const root = tree({ "src/a.ts": 'h.update("rakazo rls bypass");' });
    assert.equal(check(root, config, "--launch").status, 0);
    const res = check(tree({ "src/b.ts": "i = ghcr.io/elie222/rakazo" }), config, "--launch");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/b\.ts:1: ghcr\.io\/elie222\/rakazo \(launch placeholder\)/);
  });
});

describe("leak gate and symlinks", () => {
  it("passes a symlink whose target is inside the tree", () => {
    const root = tree({ "src/a.ts": "Dozo" });
    fs.symlinkSync("a.ts", path.join(root, "src/b.ts"));
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
  });

  it("fails on a symlink pointing outside the tree, a dangling one, and one into a sibling that shares the prefix", () => {
    const outside = tree({ "secret.ts": "Rakazo" });
    const root = tree({ "src/a.ts": "Dozo" });
    const sibling = `${root}2`;
    fs.mkdirSync(sibling);
    temps.push(sibling);
    fs.writeFileSync(path.join(sibling, "x.ts"), "Rakazo");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src/out.ts"));
    fs.symlinkSync("nowhere.ts", path.join(root, "src/dangling.ts"));
    fs.symlinkSync(path.join(sibling, "x.ts"), path.join(root, "src/sibling.ts"));
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    for (const name of ["out", "dangling", "sibling"]) assert.match(res.stderr, new RegExp(`src/${name}\\.ts: symlink`));
  });
});

describe("runtime directories", () => {
  it("never walks the top-level data/ of the stage or a nested dozo/.stage", () => {
    const root = tree({ "data/a.txt": "Rakazo", "dozo/.stage/src/a.txt": "Rakazo", "src/a.txt": "Rakazo", "src/data/b.txt": "Rakazo" });
    fs.chmodSync(path.join(root, "data"), 0o000); // root-owned on Linux: unreadable, must not crash
    const res = apply(root, configFile({ include: ["**"] }));
    fs.chmodSync(path.join(root, "data"), 0o755);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "data/a.txt"), "Rakazo");
    assert.equal(read(root, "dozo/.stage/src/a.txt"), "Rakazo");
    assert.equal(read(root, "src/a.txt"), "Dozo");
    assert.equal(read(root, "src/data/b.txt"), "Dozo");
  });
});

// ---------------------------------------------------------------------------------------------

describe("literals", () => {
  const literals = [
    { find: "/home/rakazo", replace: "/home/dozo", reason: "path" },
    { find: "rakazo-runtime:x:", replace: "dozo-runtime:x:", files: ["src/u.sh"], reason: "one file" },
  ];
  it("renames everywhere, or only in the listed files", () => {
    const root = tree({
      "src/a.ts": 'cwd = "/home/rakazo"; n = "rakazo-runtime:x:"',
      "src/u.sh": "printf 'rakazo-runtime:x:1' /home/rakazo",
    });
    const res = apply(root, configFile({ literals }));
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "src/a.ts"), 'cwd = "/home/dozo"; n = "rakazo-runtime:x:"');
    assert.equal(read(root, "src/u.sh"), "printf 'dozo-runtime:x:1' /home/dozo");
    assert.equal(apply(root, configFile({ literals })).status, 0);
  });
  it("gate flags a literal that was not applied", () => {
    const res = check(tree({ "src/a.ts": 'cwd = "/home/rakazo"' }), configFile({ literals }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /literal rule not applied/);
  });
  it("counts replacements per rule in the summary", () => {
    const root = tree({ "src/a.ts": "Rakazo Rakazo Rakazos /home/rakazo rakazo.com rakazo.com" });
    const res = apply(root, configFile({ literals }));
    assert.match(res.stdout, /^brand Rakazo -> Dozo, root /);
    assert.match(res.stdout, /files scanned: 1, changed: 1\n/);
    assert.match(res.stdout, /replacements:\n {2}blanket: 2\n {2}literal \/home\/rakazo: 1\n {2}url rakazo\.com: 2\n {2}variant Rakazos: 1\n/);
    assert.match(res.stdout, /hooks: anchored 0 of 0 applied, 0 already applied; assets 0 copied\n$/);
    const dry = apply(tree({ "src/a.ts": "Rakazo" }), configFile({ literals }), "--check");
    assert.match(dry.stdout, /^brand Rakazo -> Dozo \(dry run\), root /);
    assert.match(dry.stdout, /would change: 1\n/);
  });
});

describe("dead entries (apply --strict)", () => {
  const files = {
    "src/a.ts": 'Rakazo https://rakazo.com Rakazos Rakazo.icon ghcr.io/elie222/rakazo\nrakazo: "computer"\n/home/rakazo',
    "src/rakazo-x.ts": "x",
    "src/Rakazo.icon/i.png": "x",
  };
  const live = {
    urls: { "rakazo.com": "dozo.example" },
    variants: { Rakazos: "Dozos" },
    keep: [{ text: "Rakazo.icon", files: ["src/a.ts"], reason: "r" }],
    allow: {
      phrases: [{ text: "ghcr.io/elie222/rakazo", files: ["src/a.ts"], reason: "r" }],
      text: [{ file: "src/a.ts", text: 'rakazo: "computer"', reason: "r" }],
      paths: [{ glob: "src/rakazo-*", reason: "r" }],
      images: [{ glob: "src/Rakazo.icon/i.png", reason: "r" }],
    },
    literals: [{ find: "/home/rakazo", replace: "/home/dozo", reason: "r" }],
    leak: [],
  };
  it("a config whose every entry matches passes strict", () => {
    const res = apply(tree(files), configFile(live), "--strict");
    assert.equal(res.status, 0, res.stderr);
  });
  const dead = {
    urls: { urls: { ...live.urls, "gone.example": "x.example" } },
    variants: { variants: { Rakazos: "Dozos", Rakazoz: "Dozoz" } },
    keep: { keep: [...live.keep, { text: "Rakazo.exe", files: ["src/a.ts"], reason: "r" }] },
    "keep, right file": { keep: [{ text: "Rakazo.icon", files: ["src/other.ts"], reason: "r" }] },
    "allow.phrases": { allow: { ...live.allow, phrases: [...live.allow.phrases, { text: "gone", files: ["src/a.ts"], reason: "r" }] } },
    "allow.text": { allow: { ...live.allow, text: [{ file: "src/b.ts", text: 'rakazo: "computer"', reason: "r" }] } },
    "allow.paths": { allow: { ...live.allow, paths: [...live.allow.paths, { glob: "src/gone-*", reason: "r" }] } },
    "allow.images": { allow: { ...live.allow, images: [{ glob: "src/gone.png", reason: "r" }] } },
    literals: { literals: [...live.literals, { find: "/gone", replace: "/x", reason: "r" }] },
  };
  for (const [name, extra] of Object.entries(dead)) {
    it(`fails on a dead ${name} entry, and only with --strict`, () => {
      const root = tree(files);
      const strict = apply(root, configFile({ ...live, ...extra }), "--strict");
      assert.equal(strict.status, 2, strict.stderr);
      assert.match(strict.stderr, /dead [\w.]+ entry \(matches nothing in the tree, delete it\)/);
      assert.equal(read(root, "src/a.ts").startsWith("Rakazo"), true, "nothing is written on failure");
      assert.equal(apply(root, configFile({ ...live, ...extra })).status, 0);
    });
  }
  it("an entry that matches only a longer word is dead", () => {
    const root = tree({ "src/a.ts": "Rakazo.icons Rakazo" });
    const res = apply(root, configFile({ ...live, urls: {}, variants: {}, literals: [], allow: {}, keep: [{ text: "Rakazo.icon", files: ["src/a.ts"], reason: "r" }] }), "--strict");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /dead keep entry.*Rakazo\.icon/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("config validation", () => {
  const rejects = (raw, pattern) => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, typeof raw === "string" ? raw : JSON.stringify(raw));
    const res = check(tree({ "src/a.ts": "x" }), file);
    assert.equal(res.status, 2, `${JSON.stringify(raw)}: ${res.stderr}`);
    assert.match(res.stderr, pattern);
    assert.doesNotMatch(res.stderr, /\n\s+at /, "a message, not a stack trace");
  };
  const base = { from: "Rakazo", to: "Dozo", include: ["src/**"] };

  it("rejects unreadable or malformed JSON, a missing from or to, and an empty include", () => {
    rejects("{not json", /cannot read config/);
    rejects("[]", /must be a JSON object/);
    rejects("null", /must be a JSON object/);
    rejects({ ...base, from: undefined }, /needs `from` and `to`/);
    rejects({ ...base, to: undefined }, /needs `from` and `to`/);
    rejects({ ...base, to: 5 }, /needs `from` and `to`/);
    rejects({ ...base, include: [] }, /`include` is empty/);
    rejects({ from: "Rakazo", to: "Dozo" }, /`include` is empty/);
  });

  it("rejects unknown keys, so a typo or a removed option never disables a check silently", () => {
    rejects({ ...base, keeps: [] }, /unknown key keeps/);
    rejects({ ...base, allow: { lowercase: [] } }, /unknown key allow\.lowercase/);
    rejects({ ...base, allow: { files: [] } }, /unknown key allow\.files/);
    rejects({ ...base, allow: [] }, /`allow` must be an object/);
  });

  const entry = { glob: "x/**" };
  const lists = {
    exclude: (x) => ({ exclude: x }),
    keep: (x) => ({ keep: x }),
    "allow.phrases": (x) => ({ allow: { phrases: x } }),
    "allow.text": (x) => ({ allow: { text: x } }),
    "allow.paths": (x) => ({ allow: { paths: x } }),
    "allow.images": (x) => ({ allow: { images: x } }),
    literals: (x) => ({ literals: x }),
  };
  const good = {
    exclude: { glob: "x/**", reason: "r" },
    keep: { text: "a", files: ["x"], reason: "r" },
    "allow.phrases": { text: "a", files: ["x"], reason: "r" },
    "allow.text": { file: "x", text: "a", reason: "r" },
    "allow.paths": { glob: "x", reason: "r" },
    "allow.images": { glob: "x", reason: "r" },
    literals: { find: "a", replace: "b", reason: "r" },
  };
  for (const [name, wrap] of Object.entries(lists)) {
    it(`${name}: a reason is required on every entry, not only the first, and every field`, () => {
      const pattern = new RegExp(`every ${name.replace(".", "\\.")} entry needs a reason`);
      const { reason: _reason, ...noReason } = good[name];
      rejects({ ...base, ...wrap([noReason]) }, pattern);
      rejects({ ...base, ...wrap([good[name], noReason]) }, pattern);
      rejects({ ...base, ...wrap([noReason, good[name]]) }, pattern);
      rejects({ ...base, ...wrap([{ ...good[name], reason: "" }]) }, pattern);
      rejects({ ...base, ...wrap("x") }, /must be a list/);
      rejects({ ...base, ...wrap(["x"]) }, /must be an object/);
      for (const field of Object.keys(good[name]).filter((f) => f !== "reason" && f !== "replace")) {
        const { [field]: _dropped, ...partial } = good[name];
        rejects({ ...base, ...wrap([partial]) }, new RegExp(field === "files" ? "non-empty `files` list" : `needs ${field}`));
        rejects({ ...base, ...wrap([{ ...good[name], [field]: field === "files" ? [] : "" }]) }, new RegExp(field === "files" ? "non-empty `files` list" : `needs ${field}`));
      }
    });
  }

  it("rejects bad literals, keep scopes, maps and lists", () => {
    rejects({ ...base, literals: [{ find: "a", reason: "r" }] }, /literal needs find and replace/);
    rejects({ ...base, literals: [{ replace: "b", reason: "r" }] }, /literals entry needs find/);
    rejects({ ...base, literals: [{ find: "a", replace: "ab", reason: "r" }] }, /literal replace contains find/);
    rejects({ ...base, literals: [{ find: "a", replace: "b", files: "x", reason: "r" }] }, /literal files must be a non-empty list/);
    rejects({ ...base, literals: [{ find: "a", replace: "b", files: [], reason: "r" }] }, /literal files must be a non-empty list/);
    rejects({ ...base, keep: [{ text: "a", files: "x", reason: "r" }] }, /non-empty `files` list/);
    rejects({ ...base, keep: [{ text: "a", files: [1], reason: "r" }] }, /non-empty `files` list/);
    rejects({ ...base, keep: [{ text: "", files: ["x"], reason: "r" }] }, /keep entry needs text/);
    rejects({ ...base, urls: { "": "x.example" } }, /urls entries need/);
    rejects({ ...base, urls: { "a.example": "" } }, /urls entries need/);
    rejects({ ...base, urls: { "a.example": 5 } }, /urls entries need/);
    rejects({ ...base, urls: [] }, /`urls` must be an object/);
    rejects({ ...base, urls: { "rakazo.com": "x.RAKAZO.com" } }, /urls target contains its key/);
    rejects({ ...base, variants: { Rakazos: "Rakazos!" } }, /variants target contains its key/);
    rejects({ ...base, assets: { "a.png": "" } }, /assets entries need/);
    rejects({ ...base, include: [1] }, /`include` must be a list of non-empty strings/);
    rejects({ ...base, include: ["a", ""] }, /`include` must be a list of non-empty strings/);
    rejects({ ...base, include: "src/**" }, /`include` must be a list of non-empty strings/);
    rejects({ ...base, leak: [""] }, /`leak` must be a list/);
    rejects({ ...base, leakWords: [3] }, /`leakWords` must be a list/);
    rejects({ ...base, anchored: {} }, /`anchored` must be a list/);
    rejects({ ...base, anchored: ["x"] }, /anchored rule needs file, find, replace and reason/);
    rejects({ ...base, anchored: [{ file: "a", find: "b", replace: "c", reason: "r", requires: "x" }] }, /requires must be a list of paths/);
    rejects({ ...base, to: "Rakazo2" }, /`to` must not contain `from`/);
  });

  it("accepts an empty replace in a literal, and an absent optional section", () => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify({ ...base, literals: [{ find: "a", replace: "", reason: "r" }] }));
    const res = check(tree({ "src/a.ts": "x" }), file);
    assert.equal(res.status, 0, res.stderr);
  });
});

describe("command line", () => {
  for (const script of ["apply.mjs", "check.mjs"]) {
    it(`${script} asks for --root and rejects a root that is not a directory`, () => {
      const missing = bareRun(script);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, new RegExp(`usage: ${script.replace(".", "\\.")} --root`));
      const file = path.join(tempDir(), "plain.txt");
      fs.writeFileSync(file, "x");
      for (const root of [file, path.join(tempDir(), "nope")]) {
        const res = bareRun(script, "--root", root);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /is not a directory/);
      }
    });

    it(`${script} exits 2 on an unknown option, a repeated option, a missing value and a stray argument`, () => {
      const root = tree({ "src/a.ts": "x" });
      const config = configFile();
      const cases = [
        [["--strcit"], /unknown option --strcit/],
        [["--check-all"], /unknown option/],
        [["--config"], /--config needs a value/],
        [["--config", "--strict"], /--config needs a value/],
        [["--root", root, "--root", root], /--root given twice/],
        [["--root", root, "stray"], /unexpected argument stray/],
        [["--root"], /--root needs a value/],
        [["--root", "--launch"], /--root needs a value/],
      ];
      for (const [argv, pattern] of cases) {
        const res = bareRun(script, ...(argv[0] === "--root" ? argv : ["--root", root, ...argv]));
        assert.equal(res.status, 2, argv.join(" "));
        assert.match(res.stderr, pattern, argv.join(" "));
      }
      assert.equal(bareRun(script, "--root", root, "--config", config, ...(script === "apply.mjs" ? ["--check"] : ["--launch"])).status, 0);
    });
  }

  it("--strcit does not turn strict off: a flag of the other script is unknown too", () => {
    const root = tree({ "src/a.ts": "x" });
    assert.equal(bareRun("check.mjs", "--root", root, "--strict").status, 2);
    assert.equal(bareRun("apply.mjs", "--root", root, "--launch").status, 2);
  });

  it("falls back to the shipped brand.json when --config is not given", () => {
    const root = tree({ "src/a.ts": "x" });
    const applied = bareRun("apply.mjs", "--root", root);
    assert.equal(applied.status, 2);
    assert.match(applied.stderr, /rule failure/);
    const checked = bareRun("check.mjs", "--root", root);
    assert.equal(checked.status, 2);
    const [dest] = Object.keys(shipped.assets);
    assert.ok(dest, "the shipped config maps at least one asset");
    assert.ok(checked.stderr.includes(`${dest}: mapped asset missing from the tree`), checked.stderr);
  });
});

// ---------------------------------------------------------------------------------------------

describe("shipped brand.json", () => {
  it("is valid, every entry has a reason, and its keys are unique", () => {
    loadConfig();
    for (const entry of [...shipped.exclude, ...shipped.keep, ...shipped.allow.phrases, ...shipped.allow.text, ...shipped.allow.paths, ...shipped.allow.images, ...shipped.literals, ...shipped.anchored]) {
      assert.ok(entry.reason, JSON.stringify(entry));
    }
    const anchored = shipped.anchored.map((rule) => `${rule.file}\0${rule.find}`);
    assert.equal(new Set(anchored).size, anchored.length);
    const texts = shipped.allow.text.map((e) => `${e.file}\0${e.text}`);
    assert.equal(new Set(texts).size, texts.length);
    for (const entry of [...shipped.keep, ...shipped.allow.phrases]) assert.ok(!entry.files.some((f) => f === "**" || f === "**/*"), `${entry.text}: scoped to files`);
  });

  /** A tree with one file holding `text`, branded with the shipped rules (no anchors, assets) and gated. */
  const brandAndGate = (rel, text) => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify({ ...shipped, anchored: [], assets: {} }));
    const root = tree({ [rel]: text });
    const applied = apply(root, file);
    assert.equal(applied.status, 0, applied.stderr);
    return { out: read(root, rel), gate: check(root, file) };
  };
  const sample = "apps/web/src/sample.ts";

  it("every url key: the sample is rewritten to its target and the gate is clean", () => {
    for (const [key, target] of Object.entries(shipped.urls)) {
      const { out, gate } = brandAndGate(sample, `const u = "${key}";\n`);
      assert.equal(out, `const u = "${target}";\n`, key);
      assert.equal(gate.status, 0, `${key}: ${gate.stderr}`);
    }
  });

  it("every variant: the sample is rewritten and the gate is clean", () => {
    for (const [from, to] of Object.entries(shipped.variants)) {
      const { out, gate } = brandAndGate(sample, `const u = "${from}";\n`);
      assert.equal(out, `const u = "${to}";\n`);
      assert.equal(gate.status, 0, gate.stderr);
    }
  });

  it("every keep entry: the sample stays as it is in its files and the gate is clean", () => {
    assert.ok(shipped.keep.length > 0);
    for (const entry of shipped.keep) {
      const rel = entry.files[0];
      const { out, gate } = brandAndGate(rel, `x = "${entry.text}";\n`);
      assert.equal(out, `x = "${entry.text}";\n`, entry.text);
      assert.equal(gate.status, 0, `${entry.text}: ${gate.stderr}`);
      const elsewhere = brandAndGate("apps/web/src/elsewhere.ts", `x = "${entry.text}";\n`);
      assert.notEqual(elsewhere.out, `x = "${entry.text}";\n`, `${entry.text} is kept only in its files`);
    }
  });

  it("every literal: the sample is renamed in its files and the gate is clean", () => {
    assert.ok(shipped.literals.length > 0);
    for (const literal of shipped.literals) {
      const rel = literal.files?.[0] ?? sample;
      const { out, gate } = brandAndGate(rel, `x = "${literal.find}";\n`);
      assert.equal(out, `x = "${literal.replace}";\n`, literal.find);
      assert.equal(gate.status, 0, `${literal.find}: ${gate.stderr}`);
    }
  });

  it("every allow.phrases entry is clean in its files and a leak in a file outside them", () => {
    for (const entry of shipped.allow.phrases) {
      const { gate } = brandAndGate(entry.files[0], `x = ${entry.text};\n`);
      assert.equal(gate.status, 0, `${entry.text}: ${gate.stderr}`);
      const elsewhere = brandAndGate("apps/web/src/elsewhere.ts", `x = ${entry.text};\n`);
      assert.equal(elsewhere.gate.status, 2, `${entry.text} must not be reviewed elsewhere`);
    }
  });

  it("the compaction detector accepts both prefixes and apply is idempotent on it", () => {
    const rule = shipped.anchored.find((r) => r.file.endsWith("runtime-context.ts"));
    assert.ok(rule, "the shipped config has the runtime-context rule");
    const root = tree({ [rule.file]: rule.find });
    const only = bare({ include: ["packages/**"], keep: shipped.keep, anchored: [rule] });
    assert.equal(apply(root, only).status, 0);
    const once = read(root, rule.file);
    assert.match(once, /Dozo-owned[\s\S]*Rakazo-owned/);
    assert.equal(apply(root, only).status, 0);
    assert.equal(read(root, rule.file), once);
  });

  it("the gate has a scope for every shipped exclusion and image review", () => {
    assert.ok(shipped.exclude.every((e) => typeof e.glob === "string"));
    assert.ok(shipped.allow.images.length >= 1 && shipped.allow.paths.length >= 1);
  });
});

describe("the shipped rules reach the tree through a mini stage", () => {
  it("a branded sample with every kind of text is gate-clean, and leaves identifiers alone", () => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify({ ...shipped, anchored: [], assets: {} }));
    const root = tree({
      "apps/web/src/a.ts": 'x = "Rakazo"; y = RakazoDesktop; z = "https://rakazo.com/privacy/"; w = "@rakazo/core"; q = "RAKAZO_HOST"',
    });
    const res = apply(root, file);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "apps/web/src/a.ts"), 'x = "Dozo"; y = RakazoDesktop; z = "https://dozo.example/privacy/"; w = "@rakazo/core"; q = "RAKAZO_HOST"');
    assert.equal(check(root, file).status, 0);
  });
});
