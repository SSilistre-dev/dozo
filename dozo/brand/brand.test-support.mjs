import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { buildScanner, loadConfig } from "./lib.mjs";

// Shared fixtures of the brand test files (brand.*.test.mjs). Not a module under test: the gate
// leaves `*.test-support.mjs` out of the pinned-module list and the coverage report.

const here = path.dirname(fileURLToPath(import.meta.url));
export const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-brand-test-"));
  temps.push(dir);
  return dir;
}

export function tree(files) {
  const root = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

export const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
export const shipped = JSON.parse(fs.readFileSync(path.join(here, "brand.json"), "utf8"));
/** The shipped rules for a tree of a few files: no anchored rules or assets, and no allow.text entry (it counts occurrences in its own file). */
export const withoutFiles = {
  ...shipped,
  anchored: [],
  assets: {},
  allow: { ...shipped.allow, text: [] },
};

export const URLS = {
  "rakazo.com": "dozo.example",
  "app.rakazo.com": "console.dozo.example",
  "https://apps.apple.com/app/rakazo/id6801531099": "https://dozo.example/get/ios",
  "https://discord.gg/RWwKa2Sn7h": "https://dozo.example/discord",
  "https://play.google.com/store/apps/details?id=com.rakazo.app":
    "https://dozo.example/get/android",
};

/** A small config next to the fixture, so tests do not depend on the shipped brand.json. */
export function configFile(extra = {}) {
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
export const bare = (extra = {}) =>
  configFile({ urls: {}, variants: {}, keep: [], allow: {}, leak: [], literals: [], ...extra });

const run = (script, root, config, ...more) =>
  spawnSync(
    process.execPath,
    [path.join(here, script), "--root", root, "--config", config, ...more],
    { encoding: "utf8" },
  );
export const apply = (root, config, ...more) => run("apply.mjs", root, config, ...more);
export const check = (root, config, ...more) => run("check.mjs", root, config, ...more);
export const bareRun = (script, ...argv) =>
  spawnSync(process.execPath, [path.join(here, script), ...argv], { encoding: "utf8" });

/** The gate's line scanner without a process: `scan(line, file)` returns the findings. */
export function scanner(extra = {}) {
  const { scan, scanPath } = buildScanner(loadConfig(configFile(extra)));
  return { scan: (line, file = "src/a.ts") => scan(file, line), scanPath };
}
export const texts = (findings) => findings.map((f) => f.text);
