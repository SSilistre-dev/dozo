#!/usr/bin/env node
// Joins the fragments build.mjs wrote with the pinned runtimes into the one manifest the desktop
// app downloads first: for each platform, the server bundle, Node and Postgres, each with its url,
// sha256 and size. A platform without a built bundle is left out.
// Usage: node dozo/server-bundle/manifest.mjs <dist-dir> <base-url>
// <base-url> is where the bundles will be downloaded from (a release's download folder, or a
// file:// folder for the smoke test). Node and Postgres are downloaded from there too: runtimes.mjs
// puts the pinned archives in <dist-dir> first, and each must be there and match runtimes.json.
// Writes <dist-dir>/manifest.json. Exit 0 ok, 2 failed, 64 usage.
import fs from "node:fs";
import path from "node:path";
import { fileName, matches, readRuntimes } from "./runtimes.mjs";

const [distArg, base] = process.argv.slice(2);
if (!distArg || !base) {
  process.stderr.write("usage: manifest.mjs <dist-dir> <base-url>\n");
  process.exit(64);
}
const dist = path.resolve(distArg);
const runtimes = readRuntimes();
const root = base.replace(/\/$/, "");
const fragments = fs
  .readdirSync(dist)
  .filter((file) => /^dozo-server-.+\.json$/.test(file))
  .map((file) => JSON.parse(fs.readFileSync(path.join(dist, file), "utf8")));
const versions = new Set(fragments.map((fragment) => fragment.version));
if (versions.size !== 1) {
  process.stderr.write(`[manifest] FAILED: expected one bundle version, found ${[...versions]}\n`);
  process.exit(2);
}

/** A pinned runtime at our address; `source` is where it was first published. */
const pinned = (name, platform) => {
  const entry = runtimes[name].platforms[platform];
  if (!entry) throw new Error(`runtimes.json has no ${name} for ${platform}`);
  const file = fileName(entry.url);
  if (!matches(path.join(dist, file), entry)) {
    throw new Error(`${file} is not in ${dist} as runtimes.json pins it; run runtimes.mjs first`);
  }
  return {
    version: runtimes[name].version,
    url: `${root}/${file}`,
    sha256: entry.sha256,
    size: entry.size,
    source: entry.url,
  };
};
const platforms = {};
for (const fragment of fragments.sort((a, b) => a.platform.localeCompare(b.platform))) {
  platforms[fragment.platform] = {
    server: {
      url: `${root}/${fragment.file}`,
      sha256: fragment.sha256,
      size: fragment.size,
    },
  };
  try {
    platforms[fragment.platform].node = pinned("node", fragment.platform);
    platforms[fragment.platform].postgres = pinned("postgres", fragment.platform);
  } catch (error) {
    process.stderr.write(`[manifest] FAILED: ${error.message}\n`);
    process.exit(2);
  }
}
const manifest = { schema: 1, version: [...versions][0], platforms };
fs.writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`[manifest] ${Object.keys(platforms).join(", ")} -> manifest.json\n`);
