import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./lib.mjs";

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

/** A small config next to the fixture, so tests do not depend on the shipped brand.json. */
function configFile(extra = {}) {
  const dir = tempDir();
  const file = path.join(dir, "brand.json");
  const config = {
    from: "Rakazo",
    to: "Dozo",
    variants: { Rakazos: "Dozos" },
    urls: { "rakazo.com": "dozo.example", "app.rakazo.com": "console.dozo.example" },
    include: ["src/**", "packages/**"],
    exclude: [
      { glob: "**/*.test.*", reason: "tests" },
      { glob: "**/LICENSE*", reason: "license" },
      { glob: "**/node_modules/**", reason: "deps" },
    ],
    keep: [
      { text: "Rakazo.icon", reason: "path" },
      { text: "Rakazo-owned compacted context", reason: "persisted prefix" },
      { text: "fork of Rakazo", reason: "attribution" },
    ],
    allow: { files: [], phrases: [{ text: "ghcr.io/elie222/rakazo", reason: "image" }] },
    leak: ["rakazo.com", "elie222/rakazo"],
    anchored: [],
    assets: {},
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

const run = (script, root, config, ...more) =>
  spawnSync(
    process.execPath,
    [path.join(here, script), "--root", root, "--config", config, ...more],
    {
      encoding: "utf8",
    },
  );
const apply = (root, config, ...more) => run("apply.mjs", root, config, ...more);
const check = (root, config) => run("check.mjs", root, config);

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

  it("skips excluded paths, files outside include, binaries and node_modules", () => {
    const binary = Buffer.concat([Buffer.from("Rakazo"), Buffer.from([0, 1, 2])]);
    const root = tree({
      "src/a.test.ts": "Rakazo",
      "src/LICENSE": "Rakazo",
      "docs/readme.md": "Rakazo",
      "src/node_modules/x/index.js": "Rakazo",
    });
    fs.writeFileSync(path.join(root, "src/img.bin"), binary);
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
    assert.ok(fs.readFileSync(path.join(root, "src/img.bin")).equals(binary));
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

describe("url map", () => {
  it("replaces the longest key first", () => {
    const root = tree({ "src/u.ts": '"https://app.rakazo.com/x" "https://rakazo.com/docs"' });
    apply(root, configFile());
    assert.equal(
      read(root, "src/u.ts"),
      '"https://console.dozo.example/x" "https://dozo.example/docs"',
    );
  });
});

describe("anchored rules", () => {
  const rule = (find, replace = "Y") => ({ file: "src/a.ts", find, replace, reason: "test" });

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
    assert.match(first.stdout, /anchored 1 applied, 0 already applied/);
    const second = apply(root, config);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /anchored 0 applied, 1 already applied/);
  });

  it("is a no-op the second time when replace contains find", () => {
    const root = tree({ "src/a.ts": "A B" });
    const config = configFile({ anchored: [rule("B", "B+Dozo")] });
    const first = apply(root, config);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read(root, "src/a.ts"), "A B+Dozo");
    assert.match(first.stdout, /anchored 1 applied, 0 already applied/);
    for (let i = 0; i < 2; i++) {
      const again = apply(root, config);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(read(root, "src/a.ts"), "A B+Dozo", "no second application");
      assert.match(again.stdout, /anchored 0 applied, 1 already applied/);
    }
  });

  it("fails loudly, naming rule and file, when the file has neither find nor replace", () => {
    const root = tree({ "src/a.ts": "A C" });
    const res = apply(root, configFile({ anchored: [{ ...rule("B", "B+Dozo"), reason: "my-rule" }] }));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /my-rule/);
    assert.match(res.stderr, /src\/a\.ts/);
    assert.equal(read(root, "src/a.ts"), "A C");
  });

  it("fails when replace is present but an un-replaced find is left, or find is twice", () => {
    for (const text of ["B B+Dozo", "B B"]) {
      const root = tree({ "src/a.ts": text });
      const res = apply(root, configFile({ anchored: [rule("B", "B+Dozo")] }));
      assert.equal(res.status, 2, text);
      assert.match(res.stderr, /need exactly 1/);
      assert.equal(read(root, "src/a.ts"), text);
    }
  });

  it("fails when a rule redirects to a file the staged tree does not have", () => {
    const config = (requires) => configFile({ anchored: [{ ...rule("B", "Z"), requires }] });
    const root = tree({ "src/a.ts": "A B" });
    const res = apply(root, config(["src/dozo-wrapper.ts"]));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /dangling/);
    assert.match(res.stderr, /src\/dozo-wrapper\.ts/);
    assert.equal(read(root, "src/a.ts"), "A B", "nothing is written on failure");
    fs.writeFileSync(path.join(root, "src/dozo-wrapper.ts"), "export {};");
    const ok = apply(root, config(["src/dozo-wrapper.ts"]));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(read(root, "src/a.ts"), "A Z");
  });

  it("fails when the file is missing", () => {
    const root = tree({ "src/x.ts": "" });
    const res = apply(root, configFile({ anchored: [rule("A")] }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /does not exist/);
  });
});

describe("safety", () => {
  it("is idempotent", () => {
    const root = tree({ "src/a.ts": "Rakazo https://rakazo.com Rakazos" });
    const config = configFile();
    assert.match(apply(root, config).stdout, /changed: 1/);
    const second = apply(root, config);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /changed: 0/);
    assert.match(second.stdout, /replacements:\n {2}none/);
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

  it("--check reports but writes nothing", () => {
    const root = tree({ "src/a.ts": "Rakazo" });
    const res = apply(root, configFile(), "--check");
    assert.equal(res.status, 0);
    assert.match(res.stdout, /would change: 1/);
    assert.equal(read(root, "src/a.ts"), "Rakazo");
  });
  it("--check --allow-git on a repository root fails on a broken anchor or a missing file and writes nothing", () => {
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
});

describe("assets", () => {
  it("copies a mapped file, and rejects a missing source or an escaping path", () => {
    const configDir = tempDir();
    fs.mkdirSync(path.join(configDir, "assets"));
    fs.writeFileSync(path.join(configDir, "assets/logo.svg"), "<svg/>");
    const config = path.join(configDir, "brand.json");
    const write = (assets) =>
      fs.writeFileSync(
        config,
        JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets }),
      );
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
    assert.match(missing.stderr, /does not exist/);

    write({ "../escape.svg": "logo.svg" });
    assert.equal(apply(root, config).status, 2);
    write({ "public/x.svg": "../brand.json" });
    assert.equal(apply(root, config).status, 2);
  });
});

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
  });

  it("fails with path:line: match for the old name, hosts and repo", () => {
    const root = tree({
      "src/a.ts":
        'ok\nconst t = "Sign in to Rakazo";\n"https://Rakazo.com/x" github.com/elie222/rakazo\nRakazos',
    });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    const lines = res.stderr.trim().split("\n");
    assert.deepEqual(lines.slice(0, 5), [
      "src/a.ts:2: Rakazo",
      "src/a.ts:3: Rakazo",
      "src/a.ts:3: Rakazo.com",
      "src/a.ts:3: elie222/rakazo",
      "src/a.ts:4: Rakazos",
    ]);
    assert.match(lines.at(-1), /^5 leak\(s\)/);
  });

  it("caps the list at 50 lines and prints the total", () => {
    const root = tree({ "src/a.ts": Array.from({ length: 70 }, () => "Rakazo").join("\n") });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    const lines = res.stderr.trim().split("\n");
    assert.equal(lines.length, 51);
    assert.match(lines.at(-1), /^70 leak\(s\).*capped at 50/);
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

  it("allow.files skips a whole file", () => {
    const root = tree({ "src/ATTRIBUTION.md": "Rakazo" });
    const config = configFile({
      allow: { files: [{ glob: "src/ATTRIBUTION.md", reason: "credit" }], phrases: [] },
    });
    assert.equal(check(root, config).status, 0);
  });
});

describe("shipped brand.json", () => {
  it("is valid and every exclusion and keep entry has a reason", () => {
    const config = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));
    for (const entry of [...config.exclude, ...config.keep, ...config.allow.phrases]) {
      assert.ok(entry.reason, JSON.stringify(entry));
    }
    const root = tree({
      "apps/web/src/a.ts": 'x = "Rakazo"; y = "RakazoDesktop"; z = "https://rakazo.com/privacy/"',
    });
    // anchored rules and assets need the real tree; this fixture only has one file
    const light = path.join(tempDir(), "brand.json");
    fs.writeFileSync(light, JSON.stringify({ ...config, anchored: [], assets: {} }));
    const res = spawnSync(
      process.execPath,
      [path.join(here, "apply.mjs"), "--root", root, "--config", light],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      read(root, "apps/web/src/a.ts"),
      'x = "Dozo"; y = "RakazoDesktop"; z = "https://dozo.example/privacy/"',
    );
  });
});

describe("globToRegExp", () => {
  it("handles **, * and ?", () => {
    assert.ok(globToRegExp("**/*.test.*").test("a/b/c.test.ts"));
    assert.ok(globToRegExp("**/*.test.*").test("c.test.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
    assert.ok(globToRegExp("apps/web/**").test("apps/web/src/a.ts"));
    assert.ok(!globToRegExp("apps/web/**").test("apps/webx/a.ts"));
  });
});

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
    const root = tree({ "src/a.ts": 'cwd = "/home/rakazo"' });
    const res = check(root, configFile({ literals }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /literal rule not applied/);
  });
});

describe("url keys respect word boundaries", () => {
  it("does not eat the start of rakazo.computerOwner, and the gate ignores it", () => {
    const root = tree({
      "src/a.ts": 'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://rakazo.com/x"; v = "rakazo.com"',
    });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(
      read(root, "src/a.ts"),
      'l = "rakazo.computerOwner"; k = "rakazo.composerDraft."; u = "https://dozo.example/x"; v = "dozo.example"',
    );
    assert.equal(check(root, config).status, 0);
  });
  it("gate flags a URL target glued to the next word", () => {
    const root = tree({ "src/a.ts": 'l = "dozo.exampleputerOwner"' });
    assert.equal(check(root, configFile({ urls: { "rakazo.com": "dozo.example" } })).status, 2);
  });
});

describe("lowercase visible text", () => {
  const bad = {
    "text node": "src/a.tsx|<Text>\n  rakazo\n</Text>",
    "inline text node": "src/a.tsx|<b>rakazo</b>",
    "download name": "src/a.ts|`rakazo-export-${d}.zip`",
    "quoted client name": 'src/a.ts|{ name: "rakazo" }',
    "quoted PascalCase string": 'src/a.ts|operationName: "RakazoIntrospection"',
    "po entry": 'src/a.po|msgid "rakazo-shared is reserved"',
  };
  for (const [name, spec] of Object.entries(bad)) {
    it(`gate flags a ${name}`, () => {
      const [file, text] = spec.split("|");
      const root = tree({ [file]: text });
      assert.equal(check(root, configFile({ include: ["src/**"] })).status, 2);
    });
  }
  it("leaves identifiers, .po headers and reviewed files alone", () => {
    const root = tree({
      "src/a.ts": 'x = "rakazo-browser.json"; y = "@rakazo/core"; z = "rakazo_app"',
      "src/p.po": '"Project-Id-Version: rakazo-web\\n"',
      "src/enum.ts": 'type S = "rakazo"',
    });
    const config = configFile({
      include: ["src/**"],
      allow: { files: [], phrases: [], lowercase: [{ glob: "src/enum.ts", reason: "enum" }] },
    });
    assert.equal(check(root, config).status, 0);
  });
  it("gate flags the founder's first name as a whole word", () => {
    const root = tree({ "src/a.tsx": "<Text>Elie</Text>" });
    assert.equal(check(root, configFile({ leakWords: ["Elie"] })).status, 2);
  });
});

describe("readable old brand the codemod leaves alone", () => {
  const leaks = {
    "all-caps in JSX text": ["src/a.tsx", "<p>Welcome to RAKAZO</p>"],
    "all-caps sentence": ["src/a.ts", 'const m = "RAKAZO IS UPDATING";'],
    "all-caps bare word": ["src/a.ts", "// RAKAZO"],
    "alt": ["src/a.tsx", '<img alt="rakazo logo" src={x} />'],
    "aria-label": ["src/a.tsx", '<button aria-label="Open rakazo menu" />'],
    "title": ["src/a.tsx", "<a title='About rakazo' />"],
    "placeholder": ["src/a.tsx", '<input placeholder="Ask rakazo anything" />'],
    "JSX text": ["src/a.tsx", "<p>Welcome to rakazo</p>"],
    "JSX text with a brace expression": ["src/a.tsx", "<p>Welcome to rakazo, {name}</p>"],
    "brand glued into an identifier in JSX text": ["src/a.tsx", "<p>Ask RakazoBot for help</p>"],
    "brand glued into an identifier in a prose string": ["src/a.ts", 'const m = "Ask RakazoBot to help you";'],
    "brand glued into an identifier on a prose line": ["src/a.tsx", "<p>\n  Ask RakazoBot to help you\n</p>"],
    "JSX text on its own line": ["src/a.tsx", "<p>\n  Welcome to rakazo, friend.\n</p>"],
    "prose in a string": ["src/a.ts", 'const m = "Thanks for trying rakazo, the team";'],
    "prose in a template": ["src/a.ts", "const m = `the rakazo team (${n})`;"],
    "prose followed by a period": ["src/a.ts", 'const m = "This is rakazo.";'],
    ".po msgid and msgstr": ["src/a.po", 'msgid "About rakazo"\nmsgstr "About rakazo"'],
    "x.com profile": ["src/a.tsx", '<a href="https://x.com/rakazo">X</a>'],
    "twitter.com profile": ["src/a.tsx", 'const t = "https://twitter.com/rakazo";'],
    "github profile": ["src/a.ts", 'const g = "https://github.com/rakazo";'],
    "linkedin company": ["src/a.ts", 'const l = "https://www.linkedin.com/company/rakazo";'],
    "youtube handle": ["src/a.ts", 'const y = "https://youtube.com/@rakazo";'],
    "instagram": ["src/a.ts", 'const i = "https://instagram.com/rakazo";'],
    "facebook": ["src/a.ts", 'const f = "https://facebook.com/rakazo";'],
    "t.me": ["src/a.ts", 'const t = "https://t.me/rakazo";'],
    "@handle": ["src/a.tsx", "<p>Follow @rakazo for news</p>"],
  };
  for (const [name, [file, text]] of Object.entries(leaks)) {
    it(`gate flags ${name} with path:line`, () => {
      const res = check(tree({ [file]: text }), configFile());
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, new RegExp(`${file.replace(".", "\\.")}:\\d+: `));
    });
  }

  it("flags the right line of a longer file", () => {
    const res = check(tree({ "src/a.tsx": "const a = 1;\nconst b = 2;\n<p>Hi rakazo</p>\n" }), configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/a\.tsx:3: /);
  });

  const identifiers = [
    "const home = process.env.RAKAZO_HOST;",
    "const d = __RAKAZO_VERSION__;",
    'import x from "@rakazo/core";',
    'import { y } from "@rakazo/ui-web/button";',
    'localStorage.getItem("rakazo.uiAppearance");',
    'const k = "rakazo:thread:1";',
    'const k = "rakazo-session";',
    'const h = "x-rakazo-space-id";',
    '<div className="rakazo-logo-avatar" data-rakazo="1" id="rakazo-root" />',
    'const u = "rakazo://open";',
    "const rakazoScreen = 1; const RakazoDesktop = 2; const isRakazoContainer = 3;",
    'const image = "rakazo/computer:local";',
    "const rakazo_app = 1;",
    'const u = "http://rakazo.invalid";',
    "const w = `rakazo-${randomUUID()}`;",
    "const p = `${base}\\rakazo\\.runs`;",
    ".rakazo-logo { animation: rakazo-pulse 1s; }",
    '<a href="https://github.com/elie222/rakazo-docs-lookalike" />'.replace("elie222/", "other/"),
    "<p className=\"rakazo-x\">{rakazo} {rakazoName}</p>",
    "  desktop: RakazoDesktop | undefined,",
    "  rakazoUserId: input.userId,",
    "`<body><script>RakazoPage.mount(${boot})</script></body>`",
    "// the rakazo container reuses this file",
    "/* rakazo is a name here */",
  ];
  it("leaves deliberate identifiers alone", () => {
    const root = tree({ "src/a.tsx": identifiers.join("\n") });
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
  });
  for (const [i, line] of identifiers.entries()) {
    it(`identifier ${i} is not flagged alone`, () => {
      assert.equal(check(tree({ "src/a.tsx": line }), configFile()).status, 0, line);
    });
  }

  it("lowercase patterns skip files reviewed in allow.lowercase; all-caps and links do not", () => {
    const config = configFile({
      allow: { files: [], phrases: [], lowercase: [{ glob: "src/a.tsx", reason: "enum" }] },
    });
    assert.equal(check(tree({ "src/a.tsx": "<p>Welcome to rakazo</p>" }), config).status, 0);
    assert.equal(check(tree({ "src/a.tsx": "<p>Welcome to RAKAZO</p>" }), config).status, 2);
    assert.equal(check(tree({ "src/a.tsx": 'x = "https://x.com/rakazo"' }), config).status, 2);
  });

  it("allow.phrases silences one reviewed occurrence", () => {
    const config = configFile({
      allow: { files: [], phrases: [{ text: 'update("rakazo rls bypass")', reason: "hash input" }] },
    });
    assert.equal(check(tree({ "src/a.ts": 'h.update("rakazo rls bypass");' }), config).status, 0);
  });
});

describe("runtime directories", () => {
  it("never walks the top-level data/ of the stage or a nested dozo/.stage", () => {
    const root = tree({
      "data/a.txt": "Rakazo",
      "dozo/.stage/src/a.txt": "Rakazo",
      "src/a.txt": "Rakazo",
      "src/data/b.txt": "Rakazo",
    });
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

describe("assets and images", () => {
  const mk = () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "ours.png"), Buffer.from([1, 0, 2, 3]));
    const file = path.join(dir, "brand.json");
    return { dir, file };
  };
  const base = {
    from: "Rakazo",
    to: "Dozo",
    include: ["apps/**"],
    assets: { "apps/web/public/i.png": "ours.png" },
  };
  it("apply copies the asset and the gate accepts it; an upstream file fails the gate", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify(base));
    const root = tree({});
    fs.mkdirSync(path.join(root, "apps/web/public"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/web/public/i.png"), Buffer.from([9, 0, 9]));
    assert.equal(check(root, file).status, 2);
    assert.equal(apply(root, file).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, "apps/web/public/i.png")), Buffer.from([1, 0, 2, 3]));
    assert.equal(check(root, file).status, 0);
  });
  it("gate fails on an unmapped image until it is reviewed in allow.images", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify(base));
    const root = tree({});
    fs.mkdirSync(path.join(root, "apps/web/public"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/web/public/i.png"), Buffer.from([1, 0, 2, 3]));
    fs.writeFileSync(path.join(root, "apps/web/public/new.png"), Buffer.from([7, 0]));
    const res = check(root, file);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /new\.png: image neither mapped/);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...base, allow: { images: [{ glob: "apps/web/public/new.png", reason: "r" }] } }),
    );
    assert.equal(check(root, file).status, 0);
  });
});

describe("launch gate", () => {
  it("flags placeholders and upstream image names only with --launch", () => {
    const root = tree({ "src/a.ts": 'u = "https://dozo.example/x"; r = "github.com/OWNER/dozo"; i = "ghcr.io/elie222/rakazo/app"' });
    const config = configFile();
    assert.equal(check(root, config).status, 0);
    const res = run("check.mjs", root, config, "--launch");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /launch placeholder/);
  });
});

describe("shipped anchored rules", () => {
  it("every anchored rule and literal has a reason and anchored finds are unique per file", () => {
    const config = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));
    for (const rule of [...config.anchored, ...config.literals]) assert.ok(rule.reason, JSON.stringify(rule));
    const keys = config.anchored.map((rule) => `${rule.file}\0${rule.find}`);
    assert.equal(new Set(keys).size, keys.length);
  });
  it("import-redirect anchors match the upstream files exactly once", () => {
    const repo = path.resolve(here, "../..");
    const config = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));
    for (const rule of config.anchored.filter((r) => r.requires)) {
      const file = path.join(repo, rule.file);
      if (!fs.existsSync(file)) continue; // dozo/ checked out without upstream
      assert.equal(read(repo, rule.file).split(rule.find).length - 1, 1, rule.file);
    }
  });
  it("the compaction detector accepts both prefixes and apply is idempotent on it", () => {
    const config = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));
    const rule = config.anchored.find((r) => r.file.endsWith("runtime-context.ts"));
    const root = tree({ [rule.file]: rule.find });
    const only = configFile({
      include: ["packages/**"],
      keep: config.keep,
      anchored: [rule],
    });
    assert.equal(apply(root, only).status, 0);
    const once = read(root, rule.file);
    assert.match(once, /Dozo-owned[\s\S]*Rakazo-owned/);
    assert.equal(apply(root, only).status, 0);
    assert.equal(read(root, rule.file), once);
  });
});

describe("command line entry", () => {
  const bare = (script, ...argv) =>
    spawnSync(process.execPath, [path.join(here, script), ...argv], { encoding: "utf8" });

  for (const script of ["apply.mjs", "check.mjs"]) {
    it(`${script} asks for --root and rejects a root that is not a directory`, () => {
      const missing = bare(script);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, new RegExp(`usage: ${script.replace(".", "\\.")} --root`));

      const file = path.join(tempDir(), "plain.txt");
      fs.writeFileSync(file, "x");
      for (const root of [file, path.join(tempDir(), "nope")]) {
        const res = bare(script, "--root", root);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /is not a directory/);
      }
    });
  }

  it("falls back to the shipped brand.json when --config is not given", () => {
    const root = tree({ "src/a.ts": "x" });
    const applied = bare("apply.mjs", "--root", root);
    assert.equal(applied.status, 2);
    assert.match(applied.stderr, /rule failure/);
    const checked = bare("check.mjs", "--root", root);
    assert.equal(checked.status, 2);
    assert.match(checked.stderr, /mapped asset missing from the tree/);
  });
});

describe("apply rejects incomplete anchored rules", () => {
  const complete = { file: "src/a.ts", find: "A", replace: "B", reason: "test" };
  for (const missing of ["file", "find", "replace", "reason"]) {
    it(`exit 2 and nothing written when a rule has no ${missing}`, () => {
      const root = tree({ "src/a.ts": "A Rakazo" });
      const { [missing]: _dropped, ...rule } = complete;
      const res = apply(root, configFile({ anchored: [rule] }));
      assert.equal(res.status, 2);
      assert.match(res.stderr, /anchored rule needs file, find, replace and reason/);
      assert.equal(read(root, "src/a.ts"), "A Rakazo");
    });
  }

  it("fails when a rule targets a binary file", () => {
    const root = tree({});
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/img.bin"), Buffer.from([65, 0, 1]));
    const res = apply(root, configFile({ anchored: [{ ...complete, file: "src/img.bin" }] }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/img\.bin is binary/);
  });
});

describe("leak gate with a minimal config", () => {
  const minimal = () => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"] }));
    return file;
  };

  it("reports the launch checks as on when clean, and the old name when not", () => {
    const config = minimal();
    const clean = run("check.mjs", tree({ "src/a.ts": "Dozo" }), config, "--launch");
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /launch checks on/);
    assert.doesNotMatch(check(tree({ "src/a.ts": "Dozo" }), config).stdout, /launch checks on/);

    const dirty = run("check.mjs", tree({ "src/a.ts": "Rakazo\ndozo.example" }), config, "--launch");
    assert.equal(dirty.status, 2);
    assert.match(dirty.stderr, /src\/a\.ts:1: Rakazo/);
    assert.match(dirty.stderr, /src\/a\.ts:2: dozo\.example \(launch placeholder\)/);
  });

  it("flags a mapped asset that is missing from the tree, and one whose source is gone", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets/ours.txt"), "ours");
    const config = path.join(dir, "brand.json");
    const write = (assets) =>
      fs.writeFileSync(config, JSON.stringify({ from: "Rakazo", to: "Dozo", include: ["src/**"], assets }));
    const root = tree({ "src/a.ts": "Dozo" });

    write({ "src/logo.txt": "ours.txt" });
    const missing = check(root, config);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /src\/logo\.txt: mapped asset missing from the tree/);

    fs.writeFileSync(path.join(root, "src/logo.txt"), "ours");
    assert.equal(check(root, config).status, 0);

    write({ "src/logo.txt": "gone.txt" });
    const gone = check(root, config);
    assert.equal(gone.status, 2);
    assert.match(gone.stderr, /src\/logo\.txt: differs from dozo\/brand\/assets\/gone\.txt/);
  });
});
