#!/usr/bin/env node
// Downloads the Node and Postgres archives runtimes.json pins, from where they are published
// (nodejs.org, the postgresql-binaries releases), into a folder under their own file names, and
// checks each against its pinned size and sha256. The release job puts them beside the server
// bundles, so the manifest points at our copy (manifest.mjs) and a new install never depends on
// the first publisher keeping a release. Both licences allow passing the archives on unchanged;
// the licence files inside them stay where they are (README.md, "Runtimes").
// Usage: node runtimes.mjs <dir> [platform ...]   (all platforms when none is named)
// Exit 0 ok, 2 failed (a download, a size or a sha256), 64 usage.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIMES = ["node", "postgres"];

export const readRuntimes = () =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "runtimes.json"), "utf8"));

/** The file name a pinned runtime keeps on our release: the last part of its address. */
export const fileName = (url) => path.basename(new URL(url).pathname);

export const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Whether a file is the pinned one: same size and sha256. */
export function matches(file, pinned) {
  return (
    fs.existsSync(file) && fs.statSync(file).size === pinned.size && sha256(file) === pinned.sha256
  );
}

/** One pinned runtime in `dir`, downloaded unless already there and right; returns its path. */
export async function fetchRuntime(name, platform, runtimes, dir) {
  const pinned = runtimes[name]?.platforms[platform];
  if (!pinned) throw new Error(`runtimes.json has no ${name} for ${platform}`);
  const file = path.join(dir, fileName(pinned.url));
  if (matches(file, pinned)) return file;
  const response = await fetch(pinned.url);
  if (!response.ok) throw new Error(`${pinned.url}: HTTP ${response.status}`);
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  if (!matches(partial, pinned)) {
    fs.rmSync(partial);
    throw new Error(`${pinned.url}: size or sha256 differs from runtimes.json`);
  }
  fs.renameSync(partial, file);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [dir, ...named] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write("usage: runtimes.mjs <dir> [platform ...]\n");
    process.exit(64);
  }
  const runtimes = readRuntimes();
  const platforms = named.length > 0 ? named : Object.keys(runtimes.node.platforms);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const platform of platforms) {
      for (const name of RUNTIMES) {
        const file = await fetchRuntime(name, platform, runtimes, dir);
        process.stdout.write(`[runtimes] ${platform} ${name}: ${path.basename(file)} ok\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[runtimes] FAILED: ${error.message}\n`);
    process.exit(2);
  }
}
