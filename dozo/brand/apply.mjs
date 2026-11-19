#!/usr/bin/env node
/**
 * Applies the Dozo brand to a staged copy of the source tree.
 *
 *   node dozo/brand/apply.mjs --root <dir> [--check] [--allow-git] [--strict] [--config <file>]
 *
 * --strict is for a tree no rule has touched yet (a fresh stage, the committed tree): a rule that
 * counts as "already applied" there is upstream drift hiding behind a short `replace`, every
 * anchored rule must have applied, and every url key, literal, variant, keep and allow entry must
 * match something (an entry that matches nothing is dead and is deleted from brand.json); an
 * `allow.text` entry must also occur exactly `count` times, and with the shipped config every
 * SHAPES row and stem must match something. Without it a re-run on an already rewritten tree is a
 * no-op.
 *
 * A `placeholders` entry (an address that does not exist, such as `dozo.example`) left in any
 * branded file fails, strict or not.
 *
 * Exit 0 on success, 2 on any failure. Everything is validated before the first write, so a rule
 * failure writes nothing; the write phase replaces each file through a temp file and a rename, and
 * an I/O error during it exits 2 with "stage is partial, re-stage". --check never writes.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BINARY_EXT,
  countText,
  DEFAULT_CONFIG,
  deadShapes,
  entryApplies,
  expectedCount,
  fail,
  guard,
  inScope,
  listFiles,
  loadConfig,
  parseArgs,
  phraseRe,
  placeholderHits,
  readFile,
  rewrite,
  writeAtomic,
} from "./lib.mjs";

guard();
const args = parseArgs(process.argv.slice(2), ["check", "allow-git", "strict"]);
if (!args.root)
  fail("usage: apply.mjs --root <dir> [--check] [--allow-git] [--strict] [--config <file>]");
const root = path.resolve(args.root);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
if (fs.existsSync(path.join(root, ".git")) && !args["allow-git"]) {
  fail(
    `${root} contains .git: refusing to brand a real working tree (use --allow-git to override)`,
  );
}

const configFile = path.resolve(args.config ?? DEFAULT_CONFIG);
const config = loadConfig(configFile);
const errors = [];
const counts = {};
const planned = new Map();
let scanned = 0;
let anchoredApplied = 0;
let anchoredAlready = 0;

const anchoredByFile = new Map();
for (const rule of config.anchored)
  anchoredByFile.set(rule.file, [...(anchoredByFile.get(rule.file) ?? []), rule]);

const assets = [];
const assetsDir = path.join(config.dir, "assets");
for (const [dest, source] of Object.entries(config.assets)) {
  const from = path.resolve(assetsDir, source);
  const to = path.resolve(root, dest);
  if (source.split(/[\\/]/).includes("..") || !from.startsWith(assetsDir + path.sep)) {
    errors.push(`asset ${dest}: source ${source} must stay under assets/`);
  } else if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
    errors.push(`asset ${dest}: source ${source} does not exist or is not a file`);
  } else if (!to.startsWith(root + path.sep)) {
    errors.push(`asset ${dest}: destination escapes the root`);
  } else if (fs.existsSync(to) && !fs.statSync(to).isFile()) {
    errors.push(`asset ${dest}: destination exists and is not a file`);
  } else assets.push({ from, to, dest });
}

const links = [];
const files = listFiles(root, links);
const fileSet = new Set(files);
for (const file of anchoredByFile.keys()) {
  if (links.includes(file))
    errors.push(
      `anchored rule: ${file} is a symlink (symlinks are never rewritten); point the rule at the real file`,
    );
  else if (!fileSet.has(file)) errors.push(`anchored rule: ${file} does not exist`);
}
// A rule that redirects to a fork file lists it in `requires`: never ship a dangling import.
for (const rule of config.anchored) {
  for (const need of rule.requires ?? []) {
    if (!fileSet.has(need)) {
      errors.push(
        `anchored rule (${rule.reason}): dangling redirect, ${need} does not exist in the tree`,
      );
    }
  }
}

const finalText = new Map(); // scoped files after the rewrite, for the dead-entry check
for (const rel of files) {
  const rules = anchoredByFile.get(rel) ?? [];
  const scoped = inScope(config, rel);
  if (!scoped && rules.length === 0) continue;
  const read = readFile(root, rel);
  if (read.binary) {
    if (rules.length) errors.push(`anchored rule: ${rel} is binary`);
    else if (!BINARY_EXT.test(rel))
      errors.push(
        `${rel}: binary content (NUL byte) in a file type that is not a known binary: UTF-16 text? it cannot be branded; convert it or exclude it`,
      );
    continue;
  }
  const original = read.text;
  let text = original;
  for (const rule of rules) {
    const hits = text.split(rule.find).length - 1;
    if (hits === 1) {
      text = text.replace(rule.find, () => rule.replace);
      anchoredApplied++;
    } else if (hits === 0 && text.includes(rule.replace)) {
      if (args.strict) {
        errors.push(
          `anchored rule (${rule.reason}): ${rel} already applied (find is gone, replace is present) on a tree that should be fresh: upstream drifted, or the tree was branded before (re-stage)`,
        );
      }
      anchoredAlready++;
    } else {
      const crlf =
        hits === 0 &&
        rule.find.includes("\n") &&
        !rule.find.includes("\r\n") &&
        text.includes("\r\n");
      errors.push(
        `anchored rule (${rule.reason}): ${rel} has ${hits} matches of ${JSON.stringify(rule.find)}, need exactly 1${hits === 0 ? " (replace is not there either)" : ""}${crlf ? "; the file uses CRLF line endings and find has \\n: write the line breaks as \\r\\n" : ""}`,
      );
    }
  }
  if (scoped) {
    scanned++;
    text = rewrite(text, config, counts, rel);
    finalText.set(rel, text);
    for (const hit of placeholderHits(config, text))
      errors.push(
        `${rel}:${hit} is a placeholder and would ship (point it at a real address or remove it)`,
      );
  }
  if (text !== original) planned.set(rel, text);
}
if (scanned === 0)
  errors.push("no file is in scope (check `include`, `exclude` and --root): nothing was branded");

const dead = (kind, name) =>
  errors.push(`dead ${kind} entry (matches nothing in the tree, delete it): ${name}`);
// The shape table is the shipped brand's own: only the shipped config is held to it, and whatever else fails.
if (args.strict && configFile === DEFAULT_CONFIG) {
  for (const { shape, stem } of deadShapes(finalText.values()))
    dead(
      stem === undefined ? "shapes" : "shapes.stems",
      stem === undefined ? shape : `${shape}: ${stem}`,
    );
}

if (args.strict && errors.length === 0) {
  for (const key of Object.keys(config.urls)) if (!counts[`url ${key}`]) dead("urls", key);
  for (const key of Object.keys(config.variants))
    if (!counts[`variant ${key}`]) dead("variants", key);
  for (const literal of config.literals)
    if (!counts[`literal ${literal.find}`]) dead("literals", literal.find);
  const found = (entry, test) =>
    [...finalText].some(([rel, text]) => test(rel) && phraseRe(entry.text).test(text));
  for (const entry of config.keep)
    if (!found(entry, (rel) => entryApplies(entry, rel))) dead("keep", entry.text);
  for (const entry of config.allow.phrases)
    if (!found(entry, (rel) => entryApplies(entry, rel))) dead("allow.phrases", entry.text);
  for (const entry of config.allow.text) {
    const n = countText(entry, finalText.get(entry.file) ?? "");
    if (n === 0) dead("allow.text", `${entry.file}: ${entry.text}`);
    else if (n !== expectedCount(entry))
      errors.push(
        `allow.text ${entry.file}: ${entry.text} occurs ${n} times, expected ${expectedCount(entry)} (review the new occurrence, then set count)`,
      );
  }
  const paths = new Set(
    files.flatMap((rel) => rel.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))),
  );
  for (const [name, list, res] of [
    ["allow.paths", config.allow.paths, config.allowPathsRe],
    ["allow.binary", config.allow.binary, config.allowBinaryRe],
  ]) {
    list.forEach((entry, i) => {
      if (![...paths].some((p) => res[i].test(p))) dead(name, entry.glob);
    });
  }
}

let assetsChanged = 0;
const copies = [];
for (const asset of assets) {
  const data = fs.readFileSync(asset.from);
  if (!fs.existsSync(asset.to) || !fs.readFileSync(asset.to).equals(data)) {
    assetsChanged++;
    copies.push({ ...asset, data });
  }
}

if (errors.length) {
  console.error(`dozo-brand: ${errors.length} rule failure(s), nothing written:`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(2);
}

if (!args.check) {
  try {
    for (const { to, data } of copies) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      writeAtomic(to, data);
    }
    for (const [rel, text] of planned) writeAtomic(path.join(root, rel), text);
  } catch (error) {
    fail(`I/O error while writing, the stage is partial, re-stage it: ${error.message}`);
  }
}

const verb = args.check ? "would change" : "changed";
console.log(`brand ${config.from} -> ${config.to}${args.check ? " (dry run)" : ""}, root ${root}`);
console.log(`files scanned: ${scanned}, ${verb}: ${planned.size + assetsChanged}`);
console.log("replacements:");
const keys = Object.keys(counts).sort();
for (const key of keys) console.log(`  ${key}: ${counts[key]}`);
if (keys.length === 0) console.log("  none");
console.log(
  `hooks: anchored ${anchoredApplied} of ${config.anchored.length} applied, ${anchoredAlready} already applied; assets ${assetsChanged} copied`,
);
