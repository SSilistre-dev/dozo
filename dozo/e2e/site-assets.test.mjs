// dozo/deploy/site-assets.sh stamp: the address of a local asset carries its content, so a cache in
// front of the landing page cannot serve an old stylesheet to a new page. The verify half needs a
// server and curl, which this image has not: it is run by `deploy.sh site` against the live page.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/site-assets.sh", import.meta.url));
const page =
  '<link rel="stylesheet" href="landing.css"><link rel="icon" href="/favicon.svg">' +
  '<meta property="og:image" content="https://site.example/og.png"><a href="tr/">TR</a>';

function stamp(css, extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "site-assets-"));
  mkdirSync(join(dir, "tr"));
  writeFileSync(join(dir, "landing.css"), css);
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "index.html"), page + extra);
  writeFileSync(join(dir, "tr", "index.html"), '<link rel="stylesheet" href="../landing.css">');
  const run = () => spawnSync("bash", [script, "stamp", dir], { encoding: "utf8" });
  const result = run();
  const read = (file) => readFileSync(join(dir, file), "utf8");
  return {
    result,
    run,
    read,
    css: /href="landing\.css\?v=([0-9a-f]{10})"/.exec(read("index.html"))?.[1],
  };
}

test("the same content gets the same address, other content another", () => {
  const first = stamp("a{}");
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.ok(first.css, first.read("index.html"));
  assert.equal(stamp("a{}").css, first.css);
  assert.notEqual(stamp("b{}").css, first.css);
});

test("every page names the one file by the same version, whatever the path to it", () => {
  const { read, css, run } = stamp("a{}");
  assert.match(read("tr/index.html"), new RegExp(`href="\\.\\./landing\\.css\\?v=${css}"`));
  assert.match(read("index.html"), /href="\/favicon\.svg\?v=[0-9a-f]{10}"/);
  // Not ours to version: another origin, and a link to a page.
  assert.match(read("index.html"), /content="https:\/\/site\.example\/og\.png"/);
  assert.match(read("index.html"), /href="tr\/"/);
  const once = read("index.html");
  assert.equal(run().status, 0);
  assert.equal(read("index.html"), once);
});

test("a local asset written in a way the stamp cannot version fails", () => {
  const cases = [
    "<link rel='stylesheet' href='landing.css'>",
    '<img src="/favicon.SVG">',
    '<a href="favicon.svg#x">',
  ];
  for (const extra of cases) {
    const { result } = stamp("a{}", extra);
    assert.equal(result.status, 2, extra);
  }
});

// Under tr_TR.UTF-8, GNU grep and sed read [a-z] without "i", so landing.css was never stamped.
// Where that locale is not installed (this image, CI) the run itself passes either way: the
// sha256sum on PATH records the locale the script's tools see, which must be C whatever the caller's.
test("the caller's locale does not change what is stamped", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-assets-"));
  const bin = mkdtempSync(join(tmpdir(), "site-assets-bin-"));
  const log = join(bin, "locale.log");
  writeFileSync(
    join(bin, "sha256sum"),
    `#!/bin/sh\nprintf '%s\\n' "\${LC_ALL:-}" >>'${log}'\nPATH=\${PATH#*:} exec sha256sum "$@"\n`,
    { mode: 0o755 },
  );
  const files = { "landing.css": "a{}", "landing.js": "x()", "favicon.svg": "<svg/>" };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  mkdirSync(join(dir, "tr"));
  writeFileSync(
    join(dir, "index.html"),
    '<link href="landing.css"><script src="landing.js"></script><link href="favicon.svg">',
  );
  writeFileSync(
    join(dir, "tr", "index.html"),
    '<link href="../landing.css"><script src="/landing.js"></script>',
  );
  const env = {
    ...process.env,
    LANG: "tr_TR.UTF-8",
    LC_ALL: "tr_TR.UTF-8",
    PATH: `${bin}:${process.env.PATH}`,
  };
  const result = spawnSync("bash", [script, "stamp", dir], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const version = (name) => createHash("sha256").update(files[name]).digest("hex").slice(0, 10);
  const read = (file) => readFileSync(join(dir, file), "utf8");
  assert.equal(
    read("index.html"),
    `<link href="landing.css?v=${version("landing.css")}"><script src="landing.js?v=${version("landing.js")}"></script>` +
      `<link href="favicon.svg?v=${version("favicon.svg")}">`,
  );
  assert.equal(
    read("tr/index.html"),
    `<link href="../landing.css?v=${version("landing.css")}"><script src="/landing.js?v=${version("landing.js")}"></script>`,
  );
  assert.deepEqual([...new Set(readFileSync(log, "utf8").trim().split("\n"))], ["C"]);
});

test("an address without a file fails", () => {
  const { result } = stamp("a{}", '<script src="missing.js"></script>');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing\.js/);
});
