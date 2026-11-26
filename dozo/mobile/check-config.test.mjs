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
const FILES = ["apps/mobile/app.json", "apps/mobile/lib/composer/incoming-share.ts"];
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
      "scheme is",
      "com\\.rakazo",
      "u\\.expo\\.dev",
      "inbox-zero",
      "outside the kept identifiers",
    ]) {
      assert.ok(found.includes(part), `${part}\n${found}`);
    }
  });

  it("an extension or app group outside the id family, a foreign associated domain, no Dozo scheme and a new use of the old name fail", () => {
    const expo = structuredClone(config.expo);
    const [first, share] = expo.extra.eas.build.experimental.ios.appExtensions;
    first.bundleIdentifier = "com.example.widgets";
    share.entitlements["com.apple.security.application-groups"] = ["group.com.example"];
    expo.ios.associatedDomains = [
      "webcredentials:dozo.example",
      "webcredentials:other.example?mode=developer",
    ];
    expo.scheme = ["rakazo"];
    expo.description = "Made by rakazo";
    const found = problems({ expo }, "https://dozo.example").join("\n");
    for (const part of [
      "outside",
      "uses app group group.com.example",
      "other.example",
      "Made by rakazo",
      "pairing links",
    ])
      assert.ok(found.includes(part), `${part}\n${found}`);
    assert.ok(!found.includes("webcredentials:dozo.example is not"), found);
  });
});

describe("the ids and release fields a store build relies on", () => {
  const root = branded();
  const expo = () =>
    structuredClone(JSON.parse(fs.readFileSync(path.join(root, FILES[0]), "utf8")).expo);

  it("the id family in the check is the literal the brand rules write", () => {
    const rule = shipped.literals.find((entry) => entry.find === "com.rakazo.app");
    assert.equal(expo().ios.bundleIdentifier, rule.replace);
    assert.equal(expo().android.package, rule.replace);
    assert.deepEqual(
      problems({
        expo: {
          ...expo(),
          ios: { ...expo().ios, bundleIdentifier: "dev.example.app" },
          android: { ...expo().android, package: "dev.example.app" },
        },
      }).filter((line) => line.includes("Dozo id")).length,
      2,
    );
  });

  it("the link scheme list carries dozo and the version fields are well formed", () => {
    const config = expo();
    assert.ok([config.scheme].flat().includes("dozo"));
    assert.match(config.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number.isInteger(config.android.versionCode) && config.android.versionCode > 0);
  });

  it("a missing purpose string, a status bar the theme cannot set, or a missing privacy reason fails", () => {
    const config = expo();
    delete config.ios.infoPlist.NSPhotoLibraryAddUsageDescription;
    config.ios.infoPlist.NSCameraUsageDescription = "Rakazo uses the camera.";
    config.ios.infoPlist.UIViewControllerBasedStatusBarAppearance = true;
    config.ios.privacyManifests.NSPrivacyAccessedAPITypes.shift();
    config.plugins = config.plugins.map((plugin) =>
      [plugin].flat()[0] === "expo-secure-store" ? "expo-secure-store" : plugin,
    );
    const found = problems({ expo: config }).join("\n");
    for (const part of [
      "NSPhotoLibraryAddUsageDescription is undefined",
      "NSCameraUsageDescription is",
      "UIViewControllerBasedStatusBarAppearance is not false",
      "does not declare reason CA92.1",
      "Face ID purpose string",
    ])
      assert.ok(found.includes(part), `${part}\n${found}`);
  });

  it("the microphone purpose string names dictation, the same in every plugin that writes it", () => {
    const texts = expo()
      .plugins.filter(Array.isArray)
      .map(([, options]) => options?.microphonePermission)
      .filter(Boolean);
    assert.equal(texts.length, 3);
    assert.equal(new Set(texts).size, 1);
    assert.match(texts[0], /^Dozo .*dictate/);
  });

  it("a missing or malformed version, versionCode or scheme fails", () => {
    const config = expo();
    config.version = "next";
    delete config.android.versionCode;
    config.scheme = "rakazo";
    const found = problems({ expo: config }).join("\n");
    for (const part of ["version is", "android.versionCode is", "pairing links"])
      assert.ok(found.includes(part), `${part}\n${found}`);
    config.android.versionCode = 1.5;
    assert.ok(problems({ expo: config }).join("\n").includes("android.versionCode is 1.5"));
  });
});

// build.sh archive and upload check the App Store Connect values before anything else (before even
// the "run it on a Mac" check), so the skip and the refusal of malformed values need no Mac.
describe("build.sh archive and upload without or with bad credentials", () => {
  const build = path.join(here, "build.sh");
  const KEY = "ABCDE12345";
  const ISSUER = "00000000-0000-0000-0000-000000000000";
  const run = (step, env) =>
    spawnSync("bash", [build, step], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  it("skips with exit 0 and names what is missing, never a value", () => {
    for (const step of ["archive", "upload"]) {
      const none = run(step, {});
      assert.equal(none.status, 0, none.stderr);
      assert.match(
        none.stdout,
        /skipped: not set: DOZO_ASC_KEY_ID DOZO_ASC_ISSUER_ID DOZO_ASC_KEY_P8 DOZO_APPLE_TEAM_ID/,
      );
      const some = run(step, {
        DOZO_ASC_KEY_ID: KEY,
        DOZO_ASC_ISSUER_ID: ISSUER,
        DOZO_ASC_KEY_P8: "secret-text",
      });
      assert.equal(some.status, 0, some.stderr);
      assert.match(some.stdout, /skipped: not set: DOZO_APPLE_TEAM_ID \(/);
      assert.ok(!some.stdout.includes("secret-text") && !some.stderr.includes("secret-text"));
    }
  });

  it("fails with exit 2 on a malformed key id, team id or issuer id", () => {
    const all = {
      DOZO_ASC_KEY_ID: KEY,
      DOZO_ASC_ISSUER_ID: ISSUER,
      DOZO_ASC_KEY_P8: "x",
      DOZO_APPLE_TEAM_ID: KEY,
    };
    for (const [name, text] of [
      ["DOZO_ASC_KEY_ID", /10-character key id/],
      ["DOZO_APPLE_TEAM_ID", /10-character team id/],
      ["DOZO_ASC_ISSUER_ID", /issuer id/],
    ]) {
      const res = run("archive", { ...all, [name]: "bad" });
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stderr, text);
    }
  });

  it("with valid values stops on a machine that is not a Mac, building nothing", {
    skip: process.platform === "darwin",
  }, () => {
    const res = run("upload", {
      DOZO_ASC_KEY_ID: KEY,
      DOZO_ASC_ISSUER_ID: ISSUER,
      DOZO_ASC_KEY_P8: "x",
      DOZO_APPLE_TEAM_ID: KEY,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /run it on a Mac/);
  });
});

// The Android release build's patch of the generated project (android/release-gradle.mjs). The
// fixture has the shape of Expo's template: a debug signing config, and both build types signed
// with it.
describe("release-gradle.mjs", () => {
  const script = path.join(here, "android", "release-gradle.mjs");
  const template = `android {
    defaultConfig {
        versionCode 10
        versionName "1.0.14"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution!
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}
`;

  it("sets the version and signs only the release variant with the environment's keystore", async () => {
    const { releaseGradle } = await import(script);
    const out = releaseGradle(template, "1.2.3", 4321);
    assert.match(out, /versionCode 4321\n {8}versionName "1\.2\.3"/);
    assert.match(
      out,
      /release \{\n {12}storeFile file\(System\.getenv\("DOZO_ANDROID_KEYSTORE"\)\)/,
    );
    assert.match(out, /debug \{\n {12}signingConfig signingConfigs\.debug/);
    assert.match(out, /\/\/ Caution!\n {12}signingConfig signingConfigs\.release/);
    assert.equal(out.match(/signingConfig signingConfigs\.debug/g).length, 1);
    assert.ok(!/[pP]assword\s+["']/.test(out), "no literal password");
  });

  it("refuses a bad version, a code out of range and a template it does not recognise", async () => {
    const { releaseGradle } = await import(script);
    assert.throws(() => releaseGradle(template, "next", 1), /versionName/);
    for (const code of [0, "x", 2100000001, 1.5])
      assert.throws(() => releaseGradle(template, "1.0.0", code), /versionCode/);
    assert.throws(
      () => releaseGradle(template.replace("versionCode 10", ""), "1.0.0", 1),
      /versionCode/,
    );
    assert.throws(
      () => releaseGradle(template.replace("signingConfigs {", "other {"), "1.0.0", 1),
      /signingConfigs/,
    );
    assert.throws(
      () => releaseGradle(template.replace("release {", "staging {"), "1.0.0", 1),
      /release buildType/,
    );
  });

  it("as a command rewrites the file, and exits 2 on a bad call", () => {
    const file = path.join(temp, "build.gradle");
    fs.writeFileSync(file, template);
    const ok = spawnSync(process.execPath, [script, file, "1.0.14", "77"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(fs.readFileSync(file, "utf8"), /versionCode 77/);
    for (const args of [[], [file, "x", "1"], [path.join(temp, "none.gradle"), "1.0.0", "1"]])
      assert.equal(spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }).status, 2);
  });
});
