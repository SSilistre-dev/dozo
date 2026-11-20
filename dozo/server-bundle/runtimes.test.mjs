// node --test dozo/server-bundle/runtimes.test.mjs (run by `make olc`)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fetchRuntime, fileName, matches, readRuntimes } from "./runtimes.mjs";

const BODY = Buffer.from("a runtime archive");
const SUM = createHash("sha256").update(BODY).digest("hex");
let server;
let base;
let served = 0;
let dir;

before(async () => {
  server = createServer((req, res) => {
    served += 1;
    if (req.url === "/missing.tar.gz") res.writeHead(404).end();
    else res.writeHead(200).end(BODY);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "dozo-runtimes-test-"));
  served = 0;
});

const pinned = (file, sha256 = SUM, size = BODY.length) => ({
  node: { version: "1", platforms: { "linux-x64": { url: `${base}/dist/${file}`, sha256, size } } },
});

describe("runtimes", () => {
  it("downloads a pinned archive under its own name, once", async () => {
    const runtimes = pinned("node-v1-linux-x64.tar.xz");
    const file = await fetchRuntime("node", "linux-x64", runtimes, dir);
    assert.equal(path.basename(file), "node-v1-linux-x64.tar.xz");
    assert.deepEqual(fs.readFileSync(file), BODY);
    await fetchRuntime("node", "linux-x64", runtimes, dir);
    assert.equal(served, 1);
  });

  it("keeps nothing that differs from the pin", async () => {
    await assert.rejects(
      fetchRuntime("node", "linux-x64", pinned("a.tar.xz", "0".repeat(64)), dir),
      /size or sha256 differs/,
    );
    await assert.rejects(
      fetchRuntime("node", "linux-x64", pinned("b.tar.xz", SUM, BODY.length + 1), dir),
      /size or sha256 differs/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
    const missing = pinned("x");
    missing.node.platforms["linux-x64"].url = `${base}/missing.tar.gz`;
    await assert.rejects(fetchRuntime("node", "linux-x64", missing, dir), /HTTP 404/);
    await assert.rejects(fetchRuntime("node", "win-x64", pinned("c"), dir), /no node for win-x64/);
    await assert.rejects(fetchRuntime("postgres", "linux-x64", pinned("c"), dir), /no postgres/);
  });

  it("checks a file by size and sha256", () => {
    const file = path.join(dir, "f");
    assert.equal(matches(file, { size: 1, sha256: SUM }), false);
    fs.writeFileSync(file, BODY);
    assert.equal(matches(file, { size: BODY.length, sha256: SUM }), true);
    assert.equal(matches(file, { size: BODY.length, sha256: "0".repeat(64) }), false);
  });

  it("pins every platform of both runtimes with a name, a sha256 and a size", () => {
    const runtimes = readRuntimes();
    const names = new Set();
    for (const name of ["node", "postgres"]) {
      for (const [platform, entry] of Object.entries(runtimes[name].platforms)) {
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${name} ${platform}`);
        assert.ok(entry.size > 0, `${name} ${platform}`);
        assert.ok(entry.url.startsWith("https://"), `${name} ${platform}`);
        names.add(fileName(entry.url));
      }
    }
    // One release holds them all, so no two may share a file name.
    assert.equal(names.size, 8);
  });

  it("makes no manifest that points at a runtime the folder does not hold", () => {
    fs.writeFileSync(
      path.join(dir, "dozo-server-linux-x64.json"),
      JSON.stringify({
        platform: "linux-x64",
        version: "0.11.0-3",
        file: "dozo-server-linux-x64.tar.xz",
        sha256: SUM,
        size: 1,
      }),
    );
    const run = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "manifest.mjs"), dir, "https://example.invalid/r"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 2);
    assert.match(
      run.stderr,
      /node-v24\.22\.0-linux-x64\.tar\.xz is not in .* run runtimes\.mjs first/,
    );
    assert.equal(fs.existsSync(path.join(dir, "manifest.json")), false);
    const usage = spawnSync(process.execPath, [path.join(import.meta.dirname, "runtimes.mjs")], {
      encoding: "utf8",
    });
    assert.equal(usage.status, 64);
  });
});
