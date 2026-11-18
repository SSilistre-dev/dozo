// dozo/deploy/site-assets.sh stamp: the address of a local asset carries its content, so a cache in
// front of the landing page cannot serve an old stylesheet to a new page. The verify half needs a
// server and curl, which this image has not: it is run by `deploy.sh site` against the live page.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  return { result, run, read, css: /href="landing\.css\?v=([0-9a-f]{10})"/.exec(read("index.html"))?.[1] };
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

test("an address without a file fails", () => {
  const { result } = stamp("a{}", '<script src="missing.js"></script>');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing\.js/);
});
