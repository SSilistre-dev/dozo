// node --test dozo/server-bundle/notices.test.mjs (run by `make olc`)
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  checkLicences,
  fromPnpm,
  licenceFiles,
  NOTICES,
  PAGE,
  renderHtml,
  renderText,
  runtimeLicenceFiles,
  writeNotices,
} from "./notices.mjs";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "dozo-notices-test-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function pkg(name, files) {
  const dir = path.join(root, "store", name.replace("/", "+"));
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

describe("notices", () => {
  it("lists installed packages with their licence files, leaving the workspace's own out", () => {
    const left = pkg("left-pad", { LICENSE: "MIT text\n", "index.js": "", "license-check.js": "" });
    const scoped = pkg("@scope/thing", { "LICENSE.md": "Apache text", NOTICE: "notice text" });
    const packages = fromPnpm({
      MIT: [
        { name: "left-pad", versions: ["1.0.0", "2.0.0"], paths: [left, path.join(root, "gone")] },
        { name: "@rakazo/core", versions: ["0.1.0"], paths: [left] },
      ],
      "Apache-2.0": [{ name: "@scope/thing", versions: ["3.1.0"], paths: [scoped] }],
    });
    assert.deepEqual(
      packages.map((entry) => [
        entry.name,
        entry.version,
        entry.licence,
        entry.files.map((f) => f.name),
      ]),
      [
        ["@scope/thing", "3.1.0", "Apache-2.0", ["LICENSE.md", "NOTICE"]],
        ["left-pad", "1.0.0", "MIT", ["LICENSE"]],
      ],
    );
    assert.equal(packages[1].files[0].text, "MIT text");
  });

  it("sorts versions of one package and reads only top-level licence files", () => {
    const dir = pkg("a", { COPYING: "gpl?", "LICENSE-MIT": "mit" });
    fs.mkdirSync(path.join(dir, "LICENSE.d"));
    assert.deepEqual(
      licenceFiles(dir).map((file) => file.name),
      ["COPYING", "LICENSE-MIT"],
    );
    const packages = fromPnpm({
      MIT: [{ name: "a", versions: ["2.0.0", "1.0.0"], paths: [dir, dir] }],
    });
    assert.deepEqual(
      packages.map((entry) => entry.version),
      ["1.0.0", "2.0.0"],
    );
  });

  it("refuses a licence the policy does not name, reports one to review, applies corrections", () => {
    const policy = {
      allowed: ["MIT"],
      review: { "MPL-2.0": "why" },
      packages: { "fixed@1.0.0": "MIT" },
    };
    const packages = [
      { name: "ok", version: "1.0.0", licence: "MIT" },
      { name: "weak", version: "2.0.0", licence: "MPL-2.0" },
      { name: "strong", version: "3.0.0", licence: "AGPL-3.0" },
      { name: "fixed", version: "1.0.0", licence: "Unknown" },
    ];
    assert.deepEqual(checkLicences(packages, policy), {
      refused: ["strong@3.0.0 (AGPL-3.0)"],
      review: [{ package: "weak@2.0.0", licence: "MPL-2.0" }],
    });
    assert.equal(packages[3].licence, "MIT");
  });

  it("keeps the committed policy readable: every review has its reason, nothing twice", () => {
    const policy = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "licenses.json"), "utf8"),
    );
    assert.equal(new Set(policy.allowed).size, policy.allowed.length);
    for (const [licence, reason] of Object.entries(policy.review)) {
      assert.ok(reason.length > 20, licence);
      assert.ok(!policy.allowed.includes(licence), licence);
    }
    for (const licence of [
      "AGPL-3.0",
      "AGPL-3.0-only",
      "GPL-3.0",
      "SSPL-1.0",
      "CC-BY-NC-4.0",
      "BUSL-1.1",
    ]) {
      assert.ok(!policy.allowed.includes(licence) && !policy.review[licence], licence);
    }
  });

  it("reads a runtime's licence files and its dependency notices", () => {
    const top = path.join(root, "postgresql-16");
    fs.mkdirSync(path.join(top, "dependency-notices", "zlib1g_amd64"), { recursive: true });
    fs.mkdirSync(path.join(top, "bin"));
    fs.writeFileSync(path.join(top, "COPYRIGHT"), "PostgreSQL Global Development Group");
    fs.writeFileSync(path.join(top, "LICENSE"), "build licence");
    fs.writeFileSync(path.join(top, "dependency-notices", "zlib1g_amd64", "0-copyright"), "zlib");
    assert.deepEqual(
      runtimeLicenceFiles(top).map((file) => file.name),
      ["COPYRIGHT", "LICENSE", "dependency-notices/zlib1g_amd64/0-copyright"],
    );
    const node = path.join(root, "node-v24");
    fs.mkdirSync(node);
    fs.writeFileSync(path.join(node, "LICENSE"), "Node.js is licensed for use as follows");
    assert.deepEqual(
      runtimeLicenceFiles(node).map((file) => file.name),
      ["LICENSE"],
    );
  });

  it("writes one text and the same as a page, with the repository's licences", () => {
    const text = renderText({
      version: "0.11.0-3",
      platform: "linux-x64",
      packages: [
        {
          name: "a",
          version: "1.0.0",
          licence: "MIT",
          files: [{ name: "LICENSE", text: "<MIT> & co" }],
        },
        { name: "b", version: "2.0.0", licence: "ISC", files: [] },
      ],
      runtimes: [{ title: "PostgreSQL 16.16.0", files: [{ name: "COPYRIGHT", text: "PGDG" }] }],
    });
    assert.match(text, /^Third-party notices for the Dozo local server 0\.11\.0-3 \(linux-x64\)/);
    assert.match(text, /Packages \(2\):\n {2}a 1\.0\.0 {2}MIT\n {2}b 2\.0\.0 {2}ISC/);
    assert.match(text, /a 1\.0\.0\nLicense: MIT\n=+\n\n--- LICENSE\n\n<MIT> & co/);
    assert.match(text, /b 2\.0\.0\nLicense: ISC\n=+\n\nThe package ships no licence file\./);
    assert.match(text, /PostgreSQL 16\.16\.0\n=+\n\n--- COPYRIGHT\n\nPGDG\n$/);
    const page = renderHtml(text);
    assert.match(page, /&lt;MIT&gt; &amp; co/);
    assert.doesNotMatch(page, /<MIT>/);

    const tree = path.join(root, "tree");
    const server = path.join(root, "rakazo-server");
    fs.mkdirSync(path.join(tree, "dozo"), { recursive: true });
    fs.mkdirSync(path.join(server, "apps", "web", "dist"), { recursive: true });
    for (const file of ["LICENSE", "NOTICE", "LICENSE-DOZO", "dozo/NOTICE"]) {
      fs.writeFileSync(path.join(tree, file), `${file} text`);
    }
    writeNotices({ tree, server, text });
    assert.equal(fs.readFileSync(path.join(server, NOTICES), "utf8"), text);
    assert.equal(fs.readFileSync(path.join(server, "apps", "web", "dist", PAGE), "utf8"), page);
    assert.equal(fs.readFileSync(path.join(server, "NOTICE-DOZO"), "utf8"), "dozo/NOTICE text");
    fs.rmSync(path.join(tree, "LICENSE-DOZO"));
    assert.throws(() => writeNotices({ tree, server, text }), /LICENSE-DOZO is missing/);
  });
});
