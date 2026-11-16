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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-wp1-test-"));
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
    const res = spawnSync(process.execPath, [path.join(here, "apply.mjs"), "--root", root], {
      encoding: "utf8",
    });
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
