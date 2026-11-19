import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  apply,
  bare,
  check,
  configFile,
  read,
  scanner,
  tempDir,
  temps,
  texts,
  tree,
  URLS,
} from "./brand.test-support.mjs";
import { escapeRe, globToRegExp, isSvg, loadConfig, rewrite, writeAtomic } from "./lib.mjs";

// The codemod: blanket replace, urls, anchored rules, apply safety, assets, literals, dead entries.

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
    assert.equal(
      read(root, "packages/b.ts"),
      "Dozo.icon",
      "outside the entry's files it is rewritten",
    );
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
    for (const rel of [
      "src/a.test.ts",
      "src/LICENSE",
      "docs/readme.md",
      "src/node_modules/x/index.js",
    ]) {
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
      "packages/i18n/locales/en/messages.po":
        'msgid "Welcome to Rakazo"\nmsgstr "Welcome to Rakazo"\n',
      "packages/i18n/locales/de/messages.po":
        'msgid "Welcome to Rakazo"\nmsgstr "Willkommen bei Rakazo"\n\nmsgid "Rakazo\\"s"\nmsgstr "Rakazos"\n',
    });
    apply(root, configFile());
    const source = /t`(.*)`/.exec(read(root, "src/App.tsx"))[1];
    for (const lang of ["en", "de"]) {
      const po = read(root, `packages/i18n/locales/${lang}/messages.po`);
      assert.ok(
        po.includes(`msgid "${source}"`),
        `${lang} keeps an entry for the rewritten source`,
      );
      assert.ok(!/\bRakazo\b/.test(po));
    }
    assert.match(
      read(root, "packages/i18n/locales/de/messages.po"),
      /msgstr "Willkommen bei Dozo"/,
    );
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

  it("globToRegExp: {a,b} is one alternation; a lone or unclosed brace and a comma outside braces are literal", () => {
    const m = (glob, text) => globToRegExp(glob).test(text);
    assert.ok(
      m("a/**/*.{png,ico}", "a/b/c.png") &&
        m("a/**/*.{png,ico}", "a/c.ico") &&
        !m("a/**/*.{png,ico}", "a/c.jpg"),
    );
    assert.ok(
      !m("a.{png,ico}", "a.png,ico") && !m("a.{png,ico}", "a.{png,ico}"),
      "braces are not literal",
    );
    assert.ok(m("a,b", "a,b") && !m("a,b", "a") && m("a{b", "a{b") && m("a}b", "a}b"));
  });

  it("every shipped url key rewrites to its target, and only that exact key", () => {
    const config = loadConfig();
    for (const [key, target] of Object.entries(config.urls)) {
      assert.equal(rewrite(`x = "${key}";`, config, {}), `x = "${target}";`, key);
      assert.equal(
        rewrite(`x = "${key.toUpperCase()}";`, config, {}),
        `x = "${target}";`,
        `${key} in capitals`,
      );
      for (let i = 0; i < key.length; i++) {
        if (!".?".includes(key[i])) continue;
        // `.` must not be any character, `?` must not make the character before it optional
        const near =
          key[i] === "."
            ? key.slice(0, i) + "X" + key.slice(i + 1)
            : key.slice(0, i - 1) + key.slice(i + 1);
        assert.equal(rewrite(`x = "${near}";`, config, {}), `x = "${near}";`, near);
      }
    }
  });
});

describe("url map", () => {
  const rw = (text, urls = URLS) => rewrite(text, loadConfig(configFile({ urls })), {});

  it("replaces the longest key first", () => {
    assert.equal(
      rw('"https://app.rakazo.com/x" "https://rakazo.com/docs"'),
      '"https://console.dozo.example/x" "https://dozo.example/docs"',
    );
  });

  it("a longer key wins over a shorter key that starts the same way", () => {
    const urls = {
      "rakazo.com": "a.example",
      "rakazo.com/docs": "docs.example",
      "rakazo.com/docs/api": "api.example",
    };
    assert.equal(
      rw('"rakazo.com/docs/api/x" "rakazo.com/docs/y" "rakazo.com/z"', urls),
      '"api.example/x" "docs.example/y" "a.example/z"',
    );
  });

  it("replaces a differently capitalised URL with the mapped target exactly", () => {
    const root = tree({ "src/u.ts": '"https://Rakazo.com/x" "APP.RAKAZO.COM/y"' });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(read(root, "src/u.ts"), '"https://dozo.example/x" "console.dozo.example/y"');
    assert.equal(check(root, config).status, 0);
  });

  it("does not eat the start of rakazo.computerOwner, and the gate ignores it", () => {
    const root = tree({
      "src/a.ts":
        'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://rakazo.com/x"; v = "rakazo.com"',
    });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(
      read(root, "src/a.ts"),
      'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://dozo.example/x"; v = "dozo.example"',
    );
    assert.equal(check(root, config).status, 0);
  });

  it("a key is a whole host: no glued left side, and a subdomain is not the bare key", () => {
    for (const text of ["getrakazo.com", "status.rakazo.com", "x-rakazo.com", "my.rakazo.com"]) {
      const root = tree({ "src/a.ts": `u = "https://${text}/x";` });
      const config = configFile({ urls: { "rakazo.com": "dozo.example" } });
      assert.equal(apply(root, config).status, 0);
      assert.equal(
        read(root, "src/a.ts"),
        `u = "https://${text}/x";`,
        `${text} is another host: untouched`,
      );
      const res = check(root, config);
      assert.equal(res.status, 2, `${text} stays a leak the gate reports`);
      assert.match(res.stderr, /src\/a\.ts:1: rakazo\.com/);
    }
  });

  it("a key does not match when more query parameters follow, and the gate catches the bare ids", () => {
    const store = "https://play.google.com/store/apps/details?id=com.rakazo.app";
    assert.equal(rw(`"${store}"`), '"https://dozo.example/get/android"');
    for (const rest of ["&hl=en", "=1", "-x", "x"])
      assert.equal(rw(`"${store}${rest}"`), `"${store}${rest}"`, rest);
    const cases = {
      "store link with an extra parameter": [`"${store}&hl=en"`, "com.rakazo.app"],
      "localized App Store path": [
        '"https://apps.apple.com/us/app/rakazo/id6801531099"',
        "id6801531099",
      ],
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
    for (const tld of [
      "ai",
      "app",
      "io",
      "net",
      "org",
      "dev",
      "co",
      "xyz",
      "me",
      "cloud",
      "info",
      "tech",
      "tools",
      "so",
      "sh",
      "ly",
      "gg",
      "chat",
      "site",
      "online",
      "store",
    ]) {
      assert.deepEqual(texts(scan(`u = "https://www.rakazo.${tld}/x"`)), [`rakazo.${tld}`], tld);
    }
    assert.deepEqual(texts(scan("write to hello@rakazo.ai or HELLO@RAKAZO.AI")), [
      "rakazo.ai",
      "RAKAZO.AI",
    ]);
    assert.deepEqual(scan('"rakazo.botId" "rakazo.managed" "http://rakazo.test"'), []);
    // the dotted keys are a closed list: a TLD that is not in it is a leak too
    for (const tld of ["fun", "studio", "page", "xyz2"])
      assert.ok(scan(`u = "https://rakazo.${tld}/x"`).length >= 1, tld);
  });

  it("the gate reports the new brand followed by a public TLD that no URL target owns", () => {
    const config = configFile();
    for (const text of ['u = "https://Dozo.com/x"', 'u = "app.dozo.io"', "see dozo.AI"]) {
      const res = check(tree({ "src/a.ts": text }), config);
      assert.equal(res.status, 2, text);
      assert.match(res.stderr, /src\/a\.ts:1: .*\(brand domain\)/, text);
    }
    assert.equal(
      check(
        tree({
          "src/a.ts": 'u = "dozo.example"; v = "console.dozo.example/x"; w = "Dozo.computer"',
        }),
        config,
      ).status,
      0,
    );
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
  const rule = (find, replace = "Y", file = "src/a.ts") => ({
    file,
    find,
    replace,
    reason: "test",
  });

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
    const missing = apply(
      tree({ "src/a.ts": "x\r\n" }),
      configFile({ anchored: [rule("one", "Z")] }),
    );
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
    const config = bare({
      anchored: [
        rule("A", "1", "src/a.ts"),
        rule("A", "2", "src/b.ts"),
        rule("A", "3", "src/c.ts"),
      ],
    });
    assert.equal(apply(root, config, "--strict").status, 0);
    assert.deepEqual(
      ["a", "b", "c"].map((n) => read(root, `src/${n}.ts`)),
      ["1", "2", "3"],
    );
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

describe("placeholders", () => {
  it("fails apply, strict or not, when a branded file would ship one, naming file and line, and writes nothing", () => {
    const root = tree({
      "src/a.ts": 'a = 1;\nu = "https://rakazo.com/x";',
      "src/b.ts": 'r = "github.com/OWNER/dozo";',
      "src/c.test.ts": 'u = "dozo.example"',
    });
    const config = configFile({ placeholders: ["dozo.example", "OWNER/"] });
    for (const flags of [[], ["--strict"], ["--check"]]) {
      const res = apply(root, config, ...flags);
      assert.equal(res.status, 2, flags.join(" "));
      assert.match(res.stderr, /src\/a\.ts:2: dozo\.example is a placeholder and would ship/);
      assert.match(res.stderr, /src\/b\.ts:1: OWNER\/ is a placeholder/);
      assert.doesNotMatch(res.stderr, /c\.test\.ts/, "an excluded file is not shipped");
    }
    assert.equal(read(root, "src/a.ts"), 'a = 1;\nu = "https://rakazo.com/x";');
    const fixed = apply(
      root,
      configFile({ urls: { "rakazo.com": "real.test" }, placeholders: ["dozo.example"] }),
    );
    assert.equal(fixed.status, 0, fixed.stderr);
  });
});

describe("apply safety", () => {
  it("is idempotent, and --strict on the result fails only because of anchored rules", () => {
    const root = tree({ "src/a.ts": "Rakazo https://rakazo.com Rakazos" });
    const config = configFile();
    assert.match(apply(root, config).stdout, /changed: 1/);
    const second = apply(root, config);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /changed: 0/);
    assert.match(second.stdout, /replacements:\n {2}none/);
    assert.equal(
      apply(root, config, "--strict").status,
      2,
      "strict wants live entries: nothing is left to rewrite",
    );
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
    fs.writeFileSync(
      config,
      JSON.stringify({
        from: "Rakazo",
        to: "Dozo",
        include: ["src/**"],
        assets: { "src/public/logo.svg": "logo.svg" },
      }),
    );
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
    for (const rule of [
      { ...good, find: "NOPE", replace: "Q" },
      { ...good, file: "src/gone.ts" },
    ]) {
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
    fs.writeFileSync(
      config,
      JSON.stringify({
        from: "Rakazo",
        to: "Dozo",
        include: ["src/**"],
        assets: { "src/a.ts/logo.svg": "logo.svg" },
      }),
    );
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
    assert.equal(
      apply(root, configFile({ allow: { binary: [{ glob: "src/font.woff2", reason: "r" }] } }))
        .status,
      0,
    );
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
    const write = (assets) =>
      fs.writeFileSync(
        config,
        JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets }),
      );
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
      assert.match(
        res.stderr,
        /must stay under assets/,
        "an absolute source, or a sibling that shares the prefix, is outside assets/",
      );
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

describe("literals", () => {
  const literals = [
    { find: "/home/rakazo", replace: "/home/dozo", reason: "path" },
    {
      find: "rakazo-runtime:x:",
      replace: "dozo-runtime:x:",
      files: ["src/u.sh"],
      reason: "one file",
    },
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
    assert.match(
      res.stdout,
      /replacements:\n {2}blanket: 2\n {2}literal \/home\/rakazo: 1\n {2}url rakazo\.com: 2\n {2}variant Rakazos: 1\n/,
    );
    assert.match(
      res.stdout,
      /hooks: anchored 0 of 0 applied, 0 already applied; assets 0 copied\n$/,
    );
    const dry = apply(tree({ "src/a.ts": "Rakazo" }), configFile({ literals }), "--check");
    assert.match(dry.stdout, /^brand Rakazo -> Dozo \(dry run\), root /);
    assert.match(dry.stdout, /would change: 1\n/);
  });
});

describe("dead entries (apply --strict)", () => {
  const files = {
    "src/a.ts":
      'Rakazo https://rakazo.com Rakazos Rakazo.icon ghcr.io/elie222/rakazo\nrakazo: "computer"\n/home/rakazo',
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
      paths: [{ glob: "src/rakazo-x.ts", reason: "r" }],
      binary: [{ glob: "src/Rakazo.icon/i.png", reason: "r" }],
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
    "allow.phrases": {
      allow: {
        ...live.allow,
        phrases: [...live.allow.phrases, { text: "gone", files: ["src/a.ts"], reason: "r" }],
      },
    },
    "allow.text": {
      allow: {
        ...live.allow,
        text: [{ file: "src/b.ts", text: 'rakazo: "computer"', reason: "r" }],
      },
    },
    "allow.paths": {
      allow: { ...live.allow, paths: [...live.allow.paths, { glob: "src/gone.ts", reason: "r" }] },
    },
    "allow.binary": { allow: { ...live.allow, binary: [{ glob: "src/gone.png", reason: "r" }] } },
    literals: { literals: [...live.literals, { find: "/gone", replace: "/x", reason: "r" }] },
  };
  for (const [name, extra] of Object.entries(dead)) {
    it(`fails on a dead ${name} entry, and only with --strict`, () => {
      const root = tree(files);
      const strict = apply(root, configFile({ ...live, ...extra }), "--strict");
      assert.equal(strict.status, 2, strict.stderr);
      assert.match(strict.stderr, /dead [\w.]+ entry \(matches nothing in the tree, delete it\)/);
      assert.equal(
        read(root, "src/a.ts").startsWith("Rakazo"),
        true,
        "nothing is written on failure",
      );
      assert.equal(apply(root, configFile({ ...live, ...extra })).status, 0);
    });
  }
  it("an entry that matches only a longer word is dead", () => {
    const root = tree({ "src/a.ts": "Rakazo.icons Rakazo" });
    const res = apply(
      root,
      configFile({
        ...live,
        urls: {},
        variants: {},
        literals: [],
        allow: {},
        keep: [{ text: "Rakazo.icon", files: ["src/a.ts"], reason: "r" }],
      }),
      "--strict",
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /dead keep entry.*Rakazo\.icon/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("binary types are never decoded", () => {
  const notUtf8 = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]); // a PDF header: high bytes, no NUL
  const types = ["pdf", "woff2", "ttf", "mp4", "png", "jpg", "ico", "riv", "PDF"];

  it("a file of a known binary type with no NUL byte and no valid UTF-8 is skipped by apply and reviewed by the gate", () => {
    for (const ext of types) {
      const root = tree({ "src/a.ts": "const a = 1;" });
      fs.writeFileSync(path.join(root, `src/f.${ext}`), notUtf8);
      const applied = apply(root, configFile());
      assert.equal(applied.status, 0, `${ext}: ${applied.stderr}`);
      assert.ok(
        fs.readFileSync(path.join(root, `src/f.${ext}`)).equals(notUtf8),
        `${ext} is left as it is`,
      );
      const gate = check(root, configFile());
      assert.equal(gate.status, 2, ext);
      assert.match(
        gate.stderr,
        new RegExp(
          `src/f\\.${ext}: binary file neither mapped in "assets" nor reviewed in "allow.binary"`,
        ),
      );
      assert.doesNotMatch(gate.stderr, /not valid UTF-8/);
      assert.equal(
        check(root, configFile({ allow: { binary: [{ glob: `src/f.${ext}`, reason: "r" }] } }))
          .status,
        0,
        ext,
      );
    }
  });

  it("an svg is text: invalid UTF-8 stops apply and the gate, and an upper-case extension is scanned too", () => {
    const root = tree({ "src/a.ts": "const a = 1;" });
    fs.writeFileSync(path.join(root, "src/logo.svg"), notUtf8);
    const reviewed = configFile({ allow: { binary: [{ glob: "src/logo.svg", reason: "r" }] } });
    for (const script of [apply, check]) {
      const res = script(root, reviewed);
      assert.equal(res.status, 2, script.name);
      assert.match(res.stderr, /src\/logo\.svg is not valid UTF-8/);
    }
    const upper = tree({
      "src/a.ts": "const a = 1;",
      "src/LOGO.SVG": "<svg><title>Rakazo</title></svg>",
    });
    const res = check(
      upper,
      configFile({ allow: { binary: [{ glob: "src/LOGO.SVG", reason: "r" }] } }),
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /LOGO\.SVG:1: Rakazo/);
    assert.ok(isSvg("a.SVG") && isSvg("a.svg") && !isSvg("a.svg.png") && !isSvg("svg"));
  });
});

describe("a failed atomic write", () => {
  it("removes its temp file; a good write leaves none either", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "target/sub"), { recursive: true });
    assert.throws(
      () => writeAtomic(path.join(dir, "target"), "x"),
      "a file cannot replace a directory",
    );
    assert.deepEqual(fs.readdirSync(dir), ["target"], "no temp file next to the target");
    writeAtomic(path.join(dir, "ok.txt"), "x");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["ok.txt", "target"]);
    assert.equal(fs.readFileSync(path.join(dir, "ok.txt"), "utf8"), "x");
  });
});
