import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { problems } from "./check-config.mjs";

// Upstream's real app.json and share-group constant, branded with the shipped rules: what
// `make olc` knows about the iOS app without building it. The full check on the resolved Expo
// config is `build.sh check`.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const FILES = ["apps/mobile/app.json", "apps/mobile/lib/incoming-share.ts"];
const shipped = JSON.parse(fs.readFileSync(path.join(repo, "dozo/brand/brand.json"), "utf8"));
const upstream = JSON.parse(fs.readFileSync(path.join(repo, FILES[0]), "utf8"));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-mobile-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

/** The two files in a scratch tree, branded and gated by the shipped rules that touch them. */
function branded() {
  const root = path.join(temp, "tree");
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), path.join(root, rel));
  }
  const inTree = (file) => FILES.includes(file);
  const config = {
    ...shipped,
    include: ["apps/mobile/**"],
    assets: {},
    anchored: shipped.anchored.filter((rule) => inTree(rule.file)),
    allow: {
      ...shipped.allow,
      text: shipped.allow.text.filter((entry) => inTree(entry.file)),
      paths: [],
      binary: [],
    },
  };
  const file = path.join(temp, "brand.json");
  fs.writeFileSync(file, JSON.stringify(config));
  for (const script of ["apply.mjs", "check.mjs"]) {
    const res = spawnSync(
      process.execPath,
      [path.join(repo, "dozo/brand", script), "--root", root, "--config", file],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `${script}: ${res.stdout}${res.stderr}`);
  }
  return root;
}

describe("check-config.mjs as a command", () => {
  const script = path.join(here, "check-config.mjs");
  const run = (file, ...args) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });

  it("exits 2 on upstream's config, 0 on a clean one, and 2 without or with an unreadable file", () => {
    const bad = run(script, path.join(repo, FILES[0]));
    assert.equal(bad.status, 2, bad.stdout);
    assert.match(bad.stderr, /owner is set/);
    const good = run(script, path.join(branded(), FILES[0]), "https://dozo.example");
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Dozo values/);
    assert.equal(run(script).status, 2);
    assert.equal(run(script, path.join(temp, "missing.json")).status, 2);
  });

  it("still checks when it is reached through a symlink in a directory with a space", () => {
    const dir = path.join(temp, "with space");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(here, path.join(dir, "link"));
    const res = run(path.join(dir, "link", "check-config.mjs"), path.join(repo, FILES[0]));
    assert.equal(res.status, 2, "a guard that misses exits 0 without checking");
    assert.match(res.stderr, /owner is set/);
  });
});

describe("the mobile app's config after the brand rules", () => {
  const root = branded();
  const config = JSON.parse(fs.readFileSync(path.join(root, FILES[0]), "utf8"));

  it("carries the Dozo values and nothing of upstream's accounts", () => {
    assert.deepEqual(problems(config), []);
  });

  it("the share extension's app group in the code is the one in the config", () => {
    const share = fs.readFileSync(path.join(root, FILES[1]), "utf8");
    assert.ok(
      share.includes(`"group.${config.expo.ios.bundleIdentifier}"`),
      share.match(/IOS_SHARE_APP_GROUP.*/)?.[0],
    );
  });

  it("the check fails on upstream's own config, one line per tie to upstream", () => {
    const found = problems(upstream).join("\n");
    for (const part of [
      "name is",
      "slug is",
      "owner is set",
      "projectId is set",
      "updates.url is set",
      "updates.enabled",
      "com\\.rakazo",
      "u\\.expo\\.dev",
      "inbox-zero",
      "outside the kept identifiers",
    ]) {
      assert.ok(found.includes(part), `${part}\n${found}`);
    }
  });

  it("an extension or app group outside the id family, a foreign associated domain and a new use of the old name fail", () => {
    const expo = structuredClone(config.expo);
    const [first, share] = expo.extra.eas.build.experimental.ios.appExtensions;
    first.bundleIdentifier = "com.example.widgets";
    share.entitlements["com.apple.security.application-groups"] = ["group.com.example"];
    expo.ios.associatedDomains = [
      "webcredentials:dozo.example",
      "webcredentials:other.example?mode=developer",
    ];
    expo.description = "Made by rakazo";
    const found = problems({ expo }, "https://dozo.example").join("\n");
    for (const part of [
      "outside",
      "uses app group group.com.example",
      "other.example",
      "Made by rakazo",
    ])
      assert.ok(found.includes(part), `${part}\n${found}`);
    assert.ok(!found.includes("webcredentials:dozo.example is not"), found);
  });
});
