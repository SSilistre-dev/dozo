#!/usr/bin/env node
// Joins the fragments build.mjs wrote with the pinned runtimes into the one manifest the desktop
// app downloads first: for each platform, the server bundle, Node and Postgres, each with its url,
// sha256 and size. A platform without a built bundle is left out.
// Usage: node dozo/server-bundle/manifest.mjs <dist-dir> <base-url>
// <base-url> is where the bundles will be downloaded from (a release's download folder, or a
// file:// folder for the smoke test). Writes <dist-dir>/manifest.json. Exit 0 ok, 2 failed, 64 usage.
import fs from "node:fs";
import path from "node:path";

const [distArg, base] = process.argv.slice(2);
if (!distArg || !base) {
  process.stderr.write("usage: manifest.mjs <dist-dir> <base-url>\n");
  process.exit(64);
}
const dist = path.resolve(distArg);
const runtimes = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "runtimes.json"), "utf8"),
);
const fragments = fs
  .readdirSync(dist)
  .filter((file) => /^dozo-server-.+\.json$/.test(file))
  .map((file) => JSON.parse(fs.readFileSync(path.join(dist, file), "utf8")));
const versions = new Set(fragments.map((fragment) => fragment.version));
if (versions.size !== 1) {
  process.stderr.write(`[manifest] FAILED: expected one bundle version, found ${[...versions]}\n`);
  process.exit(2);
}

const pinned = (name, platform) => {
  const entry = runtimes[name].platforms[platform];
  if (!entry) throw new Error(`runtimes.json has no ${name} for ${platform}`);
  return { version: runtimes[name].version, ...entry };
};
const platforms = {};
for (const fragment of fragments.sort((a, b) => a.platform.localeCompare(b.platform))) {
  platforms[fragment.platform] = {
    server: {
      url: `${base.replace(/\/$/, "")}/${fragment.file}`,
      sha256: fragment.sha256,
      size: fragment.size,
    },
    node: pinned("node", fragment.platform),
    postgres: pinned("postgres", fragment.platform),
  };
}
const manifest = { schema: 1, version: [...versions][0], platforms };
fs.writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`[manifest] ${Object.keys(platforms).join(", ")} -> manifest.json\n`);
