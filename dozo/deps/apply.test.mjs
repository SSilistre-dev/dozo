import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { editManifest, lockProblems, readList, run } from "./apply.mjs";

// Offline: a small two-document lockfile in pnpm's layout, and a fake `corepack` on PATH that
// writes the lockfile pnpm would have written (or fails as it does without a network).

const SUM_A = "sha512-AAAA";
const SUM_NEW = "sha512-TkVX";
const SUM_DEP = "sha512-REVQ";

const BEFORE = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  react: 19.3.1

importers:

  apps/mobile:
    dependencies:
      '@x/a':
        specifier: 1.0.0
        version: 1.0.0(react@19.3.1)

  apps/www:
    dependencies:
      astro:
        specifier: 7.0.0
        version: 7.0.0

packages:

  '@x/a@1.0.0':
    resolution: {integrity: ${SUM_A}}

  astro@7.0.0:
    resolution: {integrity: sha512-QVNU}

  shared@1.0.0:
    resolution: {integrity: sha512-U0hB}

snapshots:

  '@x/a@1.0.0(react@19.3.1)':
    dependencies:
      shared: 1.0.0

  astro@7.0.0: {}

  shared@1.0.0: {}
`;

/** What pnpm writes after adding new@2.0.0 (which needs dep@1.0.0) to apps/mobile, with a peer
 * context and a deprecation note it recomputed on the way. */
const AFTER = BEFORE.replace(
  "        version: 1.0.0(react@19.3.1)\n",
  "        version: 1.0.0(react@19.3.1)\n      new:\n        specifier: 2.0.0\n        version: 2.0.0\n",
)
  .replace(
    "      astro:\n        specifier: 7.0.0\n        version: 7.0.0\n",
    "      astro:\n        specifier: 7.0.0\n        version: 7.0.0(shared@1.0.0)\n",
  )
  .replace(
    "  astro@7.0.0:\n    resolution: {integrity: sha512-QVNU}\n",
    "  astro@7.0.0:\n    resolution: {integrity: sha512-QVNU}\n    deprecated: old\n\n  dep@1.0.0:\n    resolution: {integrity: " +
      SUM_DEP +
      "}\n\n  new@2.0.0:\n    resolution: {integrity: " +
      SUM_NEW +
      "}\n",
  )
  .replace(
    "  astro@7.0.0: {}\n",
    "  astro@7.0.0(shared@1.0.0): {}\n\n  dep@1.0.0: {}\n\n  new@2.0.0:\n    dependencies:\n      dep: 1.0.0\n",
  );

const LIST = {
  importer: "apps/mobile",
  add: ["new@2.0.0"],
  integrity: { "new@2.0.0": SUM_NEW, "dep@1.0.0": SUM_DEP },
};

describe("lockProblems", () => {
  it("accepts the listed additions and pnpm's recomputed peer context and metadata", () => {
    assert.deepEqual(lockProblems(BEFORE, AFTER, LIST), []);
  });

  it("refuses an upstream version that moved (pnpm deduping a shared package)", () => {
    const moved = AFTER.replaceAll("shared@1.0.0", "shared@1.1.0").replaceAll(
      "shared: 1.0.0",
      "shared: 1.1.0",
    );
    const problems = lockProblems(BEFORE, moved, LIST);
    assert.ok(problems.includes("upstream package removed: shared@1.0.0"), problems.join("\n"));
    assert.ok(problems.includes("upstream package no longer installed: shared@1.0.0"));
  });

  it("refuses a changed version in another importer", () => {
    const moved = AFTER.replace(
      "        specifier: 7.0.0\n        version: 7.0.0(",
      "        specifier: 7.0.0\n        version: 7.0.1(",
    );
    assert.deepEqual(lockProblems(BEFORE, moved, LIST), [
      "apps/www: dependencies/astro was 7.0.0 -> 7.0.0, now 7.0.0 -> 7.0.1",
    ]);
  });

  it("refuses an upstream package whose integrity changed", () => {
    const changed = AFTER.replace(`{integrity: ${SUM_A}}`, "{integrity: sha512-ZZZZ}");
    assert.deepEqual(lockProblems(BEFORE, changed, LIST), [
      "upstream package integrity changed: @x/a@1.0.0",
    ]);
  });

  it("refuses a new package whose integrity is not the listed one", () => {
    const list = { ...LIST, integrity: { ...LIST.integrity, "dep@1.0.0": "sha512-T1RIRVI=" } };
    assert.deepEqual(lockProblems(BEFORE, AFTER, list), [
      "integrity mismatch for dep@1.0.0: the lockfile has sha512-REVQ",
    ]);
  });

  it("refuses a new package the list does not name", () => {
    const list = { ...LIST, integrity: { "new@2.0.0": SUM_NEW } };
    assert.deepEqual(lockProblems(BEFORE, AFTER, list), ["new package not in the list: dep@1.0.0"]);
  });

  it("refuses a listed package that is not in the lockfile, and a dependency locked at another version", () => {
    const list = {
      ...LIST,
      add: ["new@2.0.1"],
      integrity: { ...LIST.integrity, "gone@1.0.0": SUM_A },
    };
    assert.deepEqual(lockProblems(BEFORE, AFTER, list), [
      "apps/mobile: new dependencies/new 2.0.0 -> 2.0.0 is not in the list",
      "apps/mobile does not lock new@2.0.1",
      "listed but not in the lockfile: gone@1.0.0",
    ]);
  });

  it("refuses an additional dependency in another importer", () => {
    const extra = AFTER.replace(
      "  apps/www:\n    dependencies:\n",
      "  apps/www:\n    dependencies:\n      new:\n        specifier: 2.0.0\n        version: 2.0.0\n",
    );
    assert.deepEqual(lockProblems(BEFORE, extra, LIST), [
      "apps/www: new dependencies/new 2.0.0 -> 2.0.0 is not in the list",
    ]);
  });

  it("refuses changed settings, new top-level keys and new importers", () => {
    const changed = `${AFTER.replace("react: 19.3.1\n\nimporters", "react: 19.3.2\n\nimporters").replace("  apps/www:\n", "  apps/extra:\n    dependencies: {}\n\n  apps/www:\n")}\npatchedDependencies: {}\n`;
    assert.deepEqual(lockProblems(BEFORE, changed, LIST), [
      "upstream lockfile setting changed: overrides",
      "new lockfile setting: patchedDependencies",
      "new importer: apps/extra",
    ]);
  });

  it("refuses a lockfile without the importer", () => {
    const list = { ...LIST, importer: "apps/none" };
    assert.ok(lockProblems(BEFORE, AFTER, list).includes("the lockfile has no importer apps/none"));
  });

  it("refuses a line outside any key", () => {
    assert.throws(() => lockProblems("  stray: 1\n", AFTER, LIST), /outside any key/);
  });
});

describe("readList", () => {
  const list = (over) => JSON.stringify({ ...LIST, ...over });
  it("takes exact versions and sha512 integrity", () => assert.deepEqual(readList(list({})), LIST));
  it("refuses a range", () =>
    assert.throws(() => readList(list({ add: ["new@^2.0.0"] })), /exact version/));
  it("refuses a name without a version", () =>
    assert.throws(() => readList(list({ add: ["new"] })), /name@version/));
  it("refuses a weak integrity", () =>
    assert.throws(() => readList(list({ integrity: { "new@2.0.0": "sha1-AAAA" } })), /sha512/));
  it("refuses a path outside the tree", () =>
    assert.throws(() => readList(list({ importer: "../x" })), /workspace directory/));
  it("refuses a missing add or integrity", () => {
    assert.throws(() => readList(list({ add: "new@2.0.0" })), /array/);
    assert.throws(() => readList(list({ integrity: null })), /object/);
  });
});

describe("editManifest", () => {
  it("adds the listed dependencies with exact versions", () => {
    const out = JSON.parse(editManifest('{"name":"m"}', ["@x/new@2.0.0"]));
    assert.deepEqual(out.dependencies, { "@x/new": "2.0.0" });
  });
  it("keeps a dependency upstream already has at the same version", () => {
    const out = JSON.parse(editManifest('{"dependencies":{"new":"2.0.0"}}', ["new@2.0.0"]));
    assert.deepEqual(out.dependencies, { new: "2.0.0" });
  });
  it("refuses to move a version upstream pinned", () => {
    assert.throws(
      () => editManifest('{"devDependencies":{"new":"1.0.0"}}', ["new@2.0.0"]),
      /already has new@1.0.0/,
    );
  });
});

describe("run", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-deps-test-"));
  const root = path.join(temp, "tree");
  const cache = path.join(temp, "cache");
  const bin = path.join(temp, "bin");
  const listFile = path.join(temp, "list.json");
  const manifest = '{\n  "name": "@x/mobile"\n}\n';
  const lockFile = path.join(root, "pnpm-lock.yaml");
  const manifestFile = path.join(root, "apps/mobile/package.json");
  const lines = [];
  const call = (args) =>
    run(
      args,
      (line) => lines.push(line),
      (line) => lines.push(line),
    );
  /** A fake corepack: writes `lock` as the new lockfile, or fails like pnpm without a network. */
  const corepack = (lock) => {
    fs.mkdirSync(bin, { recursive: true });
    const script =
      lock === null
        ? 'echo "ERR_PNPM_META_FETCH_FAIL getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1'
        : `cat "${path.join(temp, "pnpm-out.yaml")}" > pnpm-lock.yaml`;
    if (lock !== null) fs.writeFileSync(path.join(temp, "pnpm-out.yaml"), lock);
    fs.writeFileSync(path.join(bin, "corepack"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };
  const PATH = process.env.PATH;
  after(() => {
    process.env.PATH = PATH;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  beforeEach(() => {
    lines.length = 0;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(lockFile, BEFORE);
    fs.writeFileSync(manifestFile, manifest);
    fs.writeFileSync(listFile, JSON.stringify(LIST));
    process.env.PATH = `${bin}:${PATH}`;
  });

  it("leaves the tree alone when nothing is listed", () => {
    fs.writeFileSync(listFile, JSON.stringify({ ...LIST, add: [], integrity: {} }));
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 0);
    assert.equal(fs.readFileSync(lockFile, "utf8"), BEFORE);
    assert.equal(fs.readFileSync(manifestFile, "utf8"), manifest);
    assert.match(lines.join("\n"), /none listed/);
  });

  it("resolves once, then serves the same input from the cache without the network", () => {
    fs.rmSync(cache, { recursive: true, force: true });
    corepack(AFTER);
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 0, lines.join("\n"));
    assert.equal(fs.readFileSync(lockFile, "utf8"), AFTER);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, "utf8")).dependencies, {
      new: "2.0.0",
    });
    assert.match(lines.at(-1), /\(resolved\)/);

    fs.writeFileSync(lockFile, BEFORE);
    fs.writeFileSync(manifestFile, manifest);
    corepack(null);
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 0, lines.join("\n"));
    assert.equal(fs.readFileSync(lockFile, "utf8"), AFTER);
    assert.match(lines.at(-1), /\(cached\)/);
  });

  it("fails with exit 2 and a clear reason without a network, and restores the tree", () => {
    fs.rmSync(cache, { recursive: true, force: true });
    corepack(null);
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 2);
    assert.match(lines.join("\n"), /needs the npm registry once \(network\)[\s\S]*ENOTFOUND/);
    assert.equal(fs.readFileSync(lockFile, "utf8"), BEFORE);
    assert.equal(fs.readFileSync(manifestFile, "utf8"), manifest);
  });

  it("fails with exit 2 on a lockfile that moves an upstream version, caches nothing and restores the tree", () => {
    fs.rmSync(cache, { recursive: true, force: true });
    corepack(
      AFTER.replaceAll("shared@1.0.0", "shared@1.1.0").replaceAll("shared: 1.0.0", "shared: 1.1.0"),
    );
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 2);
    assert.match(lines.join("\n"), /upstream package removed: shared@1\.0\.0/);
    assert.equal(fs.readFileSync(lockFile, "utf8"), BEFORE);
    assert.equal(fs.readFileSync(manifestFile, "utf8"), manifest);
    assert.equal(fs.existsSync(path.join(cache, "locks")), false);
  });

  it("fails with exit 2 on a bad list or a version upstream pinned, and 64 on usage", () => {
    fs.writeFileSync(listFile, "{");
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 2);
    assert.equal(
      call(["--root", root, "--cache", cache, "--list", path.join(temp, "missing.json")]),
      2,
    );
    fs.writeFileSync(listFile, JSON.stringify(LIST));
    fs.writeFileSync(manifestFile, '{"dependencies":{"new":"1.0.0"}}');
    assert.equal(call(["--root", root, "--cache", cache, "--list", listFile]), 2);
    assert.match(lines.join("\n"), /already has new@1\.0\.0/);
    assert.equal(call(["--root", root]), 64);
  });
});
