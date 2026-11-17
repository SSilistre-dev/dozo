import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildScanner, inScope, loadConfig, rewrite } from "./lib.mjs";
import { tempDir, tree, read, shipped, withoutFiles, configFile, bare, apply, check, bareRun, texts } from "./brand.test-support.mjs";

// The config, the command line and the shipped brand.json.

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
    "allow.binary": (x) => ({ allow: { binary: x } }),
    literals: (x) => ({ literals: x }),
  };
  const good = {
    exclude: { glob: "x/**", reason: "r" },
    keep: { text: "a", files: ["x"], reason: "r" },
    "allow.phrases": { text: "a", files: ["x"], reason: "r" },
    "allow.text": { file: "x", text: "a", reason: "r" },
    "allow.paths": { glob: "x", reason: "r" },
    "allow.binary": { glob: "x", reason: "r" },
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

  it("allow.paths lists exact names: a wildcard is a config error, and the old allow.images key says what it became", () => {
    for (const glob of ["src/rakazo-*", "src/rakazo-?", "**/rakazo-x", "src/*"]) {
      rejects({ ...base, allow: { paths: [{ glob, reason: "r" }] } }, /allow\.paths lists exact names, not globs/);
    }
    rejects({ ...base, allow: { images: [{ glob: "x.png", reason: "r" }] } }, /`allow\.images` was renamed `allow\.binary`/);
  });

  it("allow.text count is a whole number of 1 or more", () => {
    const text = (count) => ({ ...base, allow: { text: [{ file: "src/a.ts", text: "x", reason: "r", count }] } });
    for (const count of [0, -1, 1.5, "2", null, []]) rejects(text(count), /allow\.text count must be a whole number of 1 or more/);
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify(text(2)));
    assert.equal(loadConfig(file).allow.text[0].count, 2);
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
        [["--constructor"], /unknown option --constructor/],
        [["--toString"], /unknown option --toString/],
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
    for (const entry of [...shipped.exclude, ...shipped.keep, ...shipped.allow.phrases, ...shipped.allow.text, ...shipped.allow.paths, ...shipped.allow.binary, ...shipped.literals, ...shipped.anchored]) {
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
    fs.writeFileSync(file, JSON.stringify(withoutFiles));
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
    assert.ok(shipped.allow.paths.length >= 1);
  });
});

describe("the shipped rules reach the tree through a mini stage", () => {
  it("a branded sample with every kind of text is gate-clean, and leaves identifiers alone", () => {
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify(withoutFiles));
    const root = tree({
      "apps/web/src/a.ts": 'x = "Rakazo"; y = RakazoDesktop; z = "https://rakazo.com/privacy/"; w = "@rakazo/core"; q = "RAKAZO_HOST"',
    });
    const res = apply(root, file);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "apps/web/src/a.ts"), 'x = "Dozo"; y = RakazoDesktop; z = "https://dozo.example/privacy/"; w = "@rakazo/core"; q = "RAKAZO_HOST"');
    assert.equal(check(root, file).status, 0);
  });
});


describe("the shipped config, in literal values", () => {
  const config = loadConfig();

  it("names the brand, its variants and every URL as the fork ships them", () => {
    assert.equal(config.from, "Rakazo");
    assert.equal(config.to, "Dozo");
    assert.deepEqual(config.variants, { Rakazos: "Dozos" });
    assert.deepEqual(config.urls, {
      "rakazo.com": "dozo.example",
      "github.com/elie222/rakazo": "github.com/OWNER/dozo",
      "https://discord.gg/RWwKa2Sn7h": "https://dozo.example/discord",
      "https://apps.apple.com/app/rakazo/id6801531099": "https://dozo.example/get/ios",
      "https://play.google.com/store/apps/details?id=com.rakazo.app": "https://dozo.example/get/android",
    });
    const counts = {};
    const sample = "Rakazo Rakazos RAKAZO rakazo Rakazo's RakazoPro Rakazo.icon";
    assert.equal(rewrite(sample, config, counts, "apps/web/src/x.ts"), "Dozo Dozos RAKAZO rakazo Dozo's RakazoPro Dozo.icon");
    for (const [from, to] of [["rakazo.com", "dozo.example"], ["https://discord.gg/RWwKa2Sn7h", "https://dozo.example/discord"], ["https://apps.apple.com/app/rakazo/id6801531099", "https://dozo.example/get/ios"]]) {
      assert.equal(rewrite(`u = "${from}"`, config, {}, "apps/web/src/x.ts"), `u = "${to}"`);
    }
  });

  it("OS junk with NUL bytes under a branded path is out of scope, not a UTF-16 failure", () => {
    const root = tree({ "packages/core/src/a.ts": "Rakazo", "packages/core/.DS_Store": "\0\0Bud1\0", "packages/core/Thumbs.db": "\0\0" });
    const res = apply(root, bare({ include: ["packages/**"], exclude: shipped.exclude }), "--strict");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "packages/core/src/a.ts"), "Dozo");
  });

  it("puts the scope where it is expected", () => {
    for (const rel of ["apps/web/e2e/a.ts", "packages/testkit/index.ts", "packages/core/src/x.test.ts", "packages/core/pnpm-lock.yaml", "packages/db/prisma/schema.prisma", "apps/web/node_modules/p/i.js", "packages/adapters/src/composio-fake.ts", "apps/web/LICENSE", "packages/core/.DS_Store", "apps/web/src/Thumbs.db"]) {
      assert.equal(inScope(config, rel), false, `${rel} is excluded`);
    }
    for (const rel of ["apps/web/src/App.tsx", "apps/api/src/index.ts", "apps/worker/src/main.ts", "packages/core/src/index.ts", "infra/sandboxes/computer/Dockerfile"]) {
      assert.equal(inScope(config, rel), true, `${rel} is in scope`);
    }
    for (const rel of ["apps/www/src/a.astro", "apps/desktop/src/main.ts", "apps/desktop/assets/es.lproj/InfoPlist.strings", "apps/desktop/assets/README.md", "apps/mobile/app/a.tsx", "apps/mobile/app.json", "apps/mobile/ios-widgets/RakazoWidgets.swift", "docs/a.md", "README.md"]) {
      assert.equal(inScope(config, rel), false, `${rel} is outside include`);
    }
    // Desktop and mobile: images only; their source text, bundle ids and store entries stay out of phase 1.
    for (const rel of ["apps/desktop/assets/icon.png", "apps/desktop/assets/icon.ico", "apps/desktop/assets/new.icns", "apps/mobile/assets/splash-icon.png", "apps/mobile/ios-widgets/Assets.xcassets/AppMark.imageset/app-mark.png", "apps/mobile/src/img/a.svg"]) {
      assert.equal(inScope(config, rel), true, `${rel} is in scope`);
    }
  });

  it("flags the same leak words", () => {
    assert.deepEqual(config.leak, ["rakazo.com", "elie222/rakazo", "elie222", "id6801531099", "RWwKa2Sn7h", "com.rakazo.app"]);
    assert.deepEqual(config.leakWords, ["Elie"]);
  });

  it("lists the names allow.paths and allow.binary cover, and the allow.text entries that stand for more than one occurrence", () => {
    assert.deepEqual(config.allow.paths.map((entry) => entry.glob), [
      "infra/sandboxes/computer/rakazo-browser",
      "infra/sandboxes/computer/rakazo-browser.desktop",
      "infra/sandboxes/computer/rakazo-focus-or-launch",
      "infra/sandboxes/computer/rakazo-local-bin.sh",
      "infra/sandboxes/computer/rakazo-page-browser",
      "packages/ui-tokens/assets/Rakazo.icon",
    ]);
    assert.deepEqual(config.allow.binary, [], "every shipped image is mapped, none is only reviewed");
    assert.deepEqual(
      config.allow.text.filter((entry) => entry.count !== undefined).map((entry) => [entry.file, entry.text, entry.count]),
      [
        ["packages/core/src/bot-look.ts", 'avatarSet === "rakazo"', 2],
        ["packages/adapters/src/apple-container-sandbox.ts", "table inet rakazo", 3],
        ["packages/adapters/src/secret-store-fake.ts", '"/rakazo"', 2],
      ],
    );
    const { scanPath } = buildScanner(config);
    assert.deepEqual(scanPath("infra/sandboxes/computer/rakazo-local-bin.sh"), []);
    assert.deepEqual(scanPath("infra/sandboxes/computer/rakazo-evil"), ["infra/sandboxes/computer/rakazo-evil"]);
    assert.deepEqual(scanPath("infra/sandboxes/computer/rakazo-browser.desktop.bak"), ["infra/sandboxes/computer/rakazo-browser.desktop.bak"]);
  });
});
