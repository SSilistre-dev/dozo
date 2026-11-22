import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_PERMISSIONS, LOCATION_SERVICES, problems } from "./check-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const script = path.join(here, "check-manifest.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-manifest-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const NS = "http://schemas.android.com/apk/res/android";
const attr = (name) => `${NS}:name(0x01010003)="${name}" (Raw: "${name}")`;
/** An `aapt2 dump xmltree` of a release APK's manifest, with the given extra lines. */
const dump = (...extra) =>
  [
    `N: android=${NS} (line=2)`,
    "  E: manifest (line=2)",
    `    A: ${NS}:versionCode(0x0101021b)=1`,
    '    A: package="dev.example.app" (Raw: "dev.example.app")',
    "    E: uses-permission (line=8)",
    `      A: ${attr("android.permission.INTERNET")}`,
    "    E: uses-permission (line=9)",
    `      A: ${attr("android.permission.READ_CONTACTS")}`,
    "    E: uses-permission (line=10)",
    `      A: ${attr("android.permission.ACCESS_FINE_LOCATION")}`,
    ...extra,
    "    E: application (line=20)",
    "      E: activity (line=21)",
    `        A: ${attr("dev.example.app.MainActivity")}`,
  ].join("\n");

function run(text) {
  const file = path.join(temp, "manifest.txt");
  fs.writeFileSync(file, text);
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

describe("the APK manifest check", () => {
  it("passes a manifest with read permissions and no location service", () => {
    assert.deepEqual(problems(dump()), []);
    const result = run(dump());
    assert.equal(result.status, 0, result.stderr);
  });

  it("fails on each location service and each forbidden permission, with exit 2", () => {
    for (const name of [...LOCATION_SERVICES, ...FORBIDDEN_PERMISSIONS]) {
      const element = name.startsWith("android.") ? "uses-permission" : "service";
      const text = dump(`    E: ${element} (line=12)`, `      A: ${attr(name)}`);
      assert.equal(problems(text).length, 1, name);
      const result = run(text);
      assert.equal(result.status, 2, name);
      assert.match(result.stderr, new RegExp(name.replaceAll(".", "\\.")));
    }
    // A plain merged AndroidManifest.xml, and a service named relative to its package.
    const xml = `<manifest xmlns:android="${NS}"><uses-permission android:name="android.permission.WRITE_CALENDAR"/><application><service android:name=".services.LocationTaskService"/></application></manifest>`;
    assert.deepEqual(problems(xml), [
      "permission android.permission.WRITE_CALENDAR",
      "service .services.LocationTaskService",
    ]);
  });

  it("fails on input that is no manifest, and without an argument", () => {
    assert.throws(() => problems(""), /not an Android manifest/);
    assert.equal(run("ERROR: no such file").status, 2);
    assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
  });

  it("checks exactly the services the app's plugin removes", () => {
    const plugin = fs.readFileSync(
      path.join(repo, "apps/mobile/plugins/dozo-without-location-services.js"),
      "utf8",
    );
    const listed = plugin.match(/const SERVICES = \[([\s\S]*?)\];/)?.[1] ?? "";
    assert.deepEqual(
      [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
      LOCATION_SERVICES,
    );
  });
});
