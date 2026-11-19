#!/usr/bin/env node
/**
 * Leak gate: fails when the old brand is still user-visible in an applied tree.
 *
 *   node dozo/brand/check.mjs --root <dir> [--launch] [--config <file>]
 *
 * Every case-insensitive occurrence of the old name is a leak unless it sits in a technical
 * identifier shape (SHAPES in lib.mjs) or a reviewed phrase (`keep`, `allow.phrases`, `allow.text`
 * in brand.json). Also: url keys, `leak` needles, public domains of either brand, file and
 * directory names, binary files, symlinks and mapped assets.
 *
 * Exit 0 when clean, 2 with a `path:line: match` list (first 50) plus a total otherwise, and 2
 * when no file was scanned. A `placeholders` entry (`dozo.example`) is a finding too. `--launch` adds
 * the `allow.phrases` entries not marked `permanent: true` (upstream image names).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BINARY_EXT,
  buildScanner,
  countText,
  DEFAULT_CONFIG,
  exitWhenFlushed,
  expectedCount,
  fail,
  guard,
  inScope,
  isSvg,
  listFiles,
  loadConfig,
  parseArgs,
  phraseRe,
  placeholderHits,
  readFile,
} from "./lib.mjs";

guard();
const args = parseArgs(process.argv.slice(2), ["launch"]);
if (!args.root) fail("usage: check.mjs --root <dir> [--launch] [--config <file>]");
const root = path.resolve(args.root);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
const config = loadConfig(args.config ?? DEFAULT_CONFIG);
const { scan, scanPath } = buildScanner(config);

// Upstream image names are the `allow.phrases` that are not permanent (an HMAC input can never be a
// launch blocker).
const upstream = config.allow.phrases.filter((entry) => !entry.permanent);

const found = [];
let scanned = 0;
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

// A symlink is never read here: its target would go unchecked unless it is a file in this tree
// that is in scope (so it is scanned under its own path), so any other symlink fails loudly.
const links = [];
const tracked = listFiles(root, links);
const realRoot = fs.realpathSync(root);
for (const rel of links) {
  let real = null;
  try {
    real = fs.realpathSync(path.join(root, rel));
  } catch {}
  if (real === null || !real.startsWith(realRoot + path.sep)) {
    found.push(
      `${rel}: symlink whose target is outside the tree or cannot be resolved (not scanned)`,
    );
  } else if (inScope(config, rel)) {
    const target = real
      .slice(realRoot.length + 1)
      .split(path.sep)
      .join("/");
    if (!inScope(config, fs.statSync(real).isDirectory() ? `${target}/` : target)) {
      found.push(
        `${rel}: symlink whose target ${target} is in the tree but outside the scanned paths (not scanned)`,
      );
    }
  }
}

const reportedPaths = new Set();
const textSeen = new Map(); // allow.text entry -> occurrences in its file
for (const rel of tracked) {
  if (!inScope(config, rel)) continue;
  // Names are not rewritten: a file or directory that carries the old name is listed or reviewed in allow.paths.
  for (const bad of scanPath(rel)) {
    if (!reportedPaths.has(bad))
      found.push(
        `${bad}: file or directory name carries the old brand (rename is not done by apply; review it in allow.paths)`,
      );
    reportedPaths.add(bad);
  }
  const read = readFile(root, rel);
  if (BINARY_EXT.test(rel) && !config.assets[rel]) {
    // Images, fonts, media and documents are not text: anything not replaced through the asset map must be reviewed once.
    if (!config.allow.binary.some((_, i) => config.allowBinaryRe[i].test(rel))) {
      found.push(`${rel}: binary file neither mapped in "assets" nor reviewed in "allow.binary"`);
    }
    if (read.binary || !isSvg(rel)) continue;
  } else if (read.binary) {
    if (!BINARY_EXT.test(rel))
      found.push(
        `${rel}: binary content (NUL byte) in a file type that is not a known binary: UTF-16 text? it was not scanned`,
      );
    continue;
  }
  scanned++;
  for (const entry of config.allow.text)
    if (entry.file === rel) textSeen.set(entry, countText(entry, read.text));
  const lines = read.text.split("\n");
  for (const hit of placeholderHits(config, read.text)) found.push(`${rel}:${hit} (placeholder)`);
  const launch = args.launch
    ? upstream
        .filter((entry) => entry.filesRe.some((re) => re.test(rel)))
        .map((entry) => phraseRe(entry.text))
    : [];
  for (let i = 0; i < lines.length; i++) {
    for (const hit of scan(rel, lines[i])) {
      found.push(`${rel}:${i + 1}: ${hit.text}${hit.label ? ` (${hit.label})` : ""}`);
    }
    for (const re of launch) {
      for (const match of lines[i].matchAll(re))
        found.push(`${rel}:${i + 1}: ${match[0]} (launch placeholder)`);
    }
  }
}

// A reviewed text stands for exactly the occurrences counted in brand.json: a new one is a new leak.
for (const entry of config.allow.text) {
  const n = textSeen.get(entry) ?? 0;
  if (n !== expectedCount(entry))
    found.push(
      `${entry.file}: allow.text ${entry.text} occurs ${n} times, expected ${expectedCount(entry)} (review a new occurrence, then set count)`,
    );
}

// Mapped assets must be our files, byte for byte.
for (const [dest, source] of Object.entries(config.assets)) {
  const file = path.join(root, dest);
  const ours = path.join(config.dir, "assets", source);
  if (!fs.existsSync(file)) found.push(`${dest}: mapped asset missing from the tree`);
  else if (!fs.existsSync(ours) || sha(fs.readFileSync(file)) !== sha(fs.readFileSync(ours))) {
    found.push(
      `${dest}: differs from dozo/brand/assets/${source} (upstream image still in place?)`,
    );
  }
}

if (scanned === 0)
  found.push("nothing was checked: 0 files in scope (check `include`, `exclude` and --root)");
if (found.length === 0) {
  console.log(
    `leak gate clean: ${scanned} files scanned${args.launch ? " (launch checks on)" : ""}`,
  );
  await exitWhenFlushed(0);
}
for (const line of found.slice(0, 50)) console.error(line);
const capped = found.length > 50 ? " (list capped at 50)" : "";
console.error(`${found.length} leak(s) of the old brand in ${scanned} files scanned${capped}`);
await exitWhenFlushed(2);
