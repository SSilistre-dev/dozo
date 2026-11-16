#!/usr/bin/env node
/**
 * Applies the Dozo brand to a staged copy of the source tree.
 *
 *   node dozo/brand/apply.mjs --root <dir> [--check] [--allow-git] [--strict] [--config <file>]
 *
 * --strict is for a tree no rule has touched yet (a fresh stage, the committed tree): a rule that
 * counts as "already applied" there is upstream drift hiding behind a short `replace`, so it fails.
 * Without it a re-run on an already rewritten tree is a no-op.
 *
 * Exit 0 on success, 2 on any failure (anchored rule not matching exactly once (or already applied),
 * a rule whose `requires` file is missing, missing asset,
 * a `.git` inside <dir> without --allow-git). On failure nothing is written.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  fail,
  inScope,
  isBinary,
  listFiles,
  loadConfig,
  parseArgs,
  rewrite,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["check", "allow-git", "strict"]);
if (!args.root) fail("usage: apply.mjs --root <dir> [--check] [--allow-git] [--strict] [--config <file>]");
const root = path.resolve(args.root);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
if (fs.existsSync(path.join(root, ".git")) && !args["allow-git"]) {
  fail(
    `${root} contains .git: refusing to brand a real working tree (use --allow-git to override)`,
  );
}

const config = loadConfig(args.config ?? DEFAULT_CONFIG);
const errors = [];
const counts = {};
const planned = new Map();
let scanned = 0;
let anchoredApplied = 0;
let anchoredAlready = 0;

const anchoredByFile = new Map();
for (const rule of config.anchored) {
  if (!rule.file || !rule.find || rule.replace === undefined || !rule.reason) {
    errors.push(`anchored rule needs file, find, replace and reason: ${JSON.stringify(rule)}`);
    continue;
  }
  anchoredByFile.set(rule.file, [...(anchoredByFile.get(rule.file) ?? []), rule]);
}

const assets = [];
for (const [dest, source] of Object.entries(config.assets)) {
  const from = path.resolve(config.dir, "assets", source);
  const to = path.resolve(root, dest);
  if (
    source.split(/[\\/]/).includes("..") ||
    !from.startsWith(path.join(config.dir, "assets") + path.sep)
  ) {
    errors.push(`asset ${dest}: source ${source} must stay under assets/`);
  } else if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
    errors.push(`asset ${dest}: source ${source} does not exist`);
  } else if (!to.startsWith(root + path.sep)) {
    errors.push(`asset ${dest}: destination escapes the root`);
  } else assets.push({ from, to, dest });
}

const files = listFiles(root);
const fileSet = new Set(files);
for (const file of anchoredByFile.keys()) {
  if (!fileSet.has(file)) errors.push(`anchored rule: ${file} does not exist`);
}
// A rule that redirects to a fork file lists it in `requires`: never ship a dangling import.
for (const rule of config.anchored) {
  for (const need of rule.requires ?? []) {
    if (!fileSet.has(need)) {
      errors.push(`anchored rule (${rule.reason}): dangling redirect, ${need} does not exist in the tree`);
    }
  }
}

for (const rel of files) {
  const rules = anchoredByFile.get(rel) ?? [];
  const scoped = inScope(config, rel);
  if (!scoped && rules.length === 0) continue;
  const buffer = fs.readFileSync(path.join(root, rel));
  if (isBinary(buffer)) {
    if (rules.length) errors.push(`anchored rule: ${rel} is binary`);
    continue;
  }
  const original = buffer.toString("utf8");
  let text = original;
  for (const rule of rules) {
    const hits = text.split(rule.find).length - 1;
    // Already applied: replace is there and no find is left outside it (replace may contain find).
    const leftover = text.split(rule.replace).join("").split(rule.find).length - 1;
    if (text.includes(rule.replace) && leftover === 0) {
      if (args.strict) {
        errors.push(
          `anchored rule (${rule.reason}): ${rel} already applied (find is gone, replace is present) on a tree that should be fresh: upstream drifted, or the tree was branded before (re-stage)`,
        );
      }
      anchoredAlready++;
    } else if (hits === 1 && !text.includes(rule.replace)) {
      text = text.replace(rule.find, () => rule.replace);
      anchoredApplied++;
    } else {
      errors.push(
        `anchored rule (${rule.reason}): ${rel} has ${hits} matches of ${JSON.stringify(rule.find)}, need exactly 1`,
      );
    }
  }
  if (scoped) {
    scanned++;
    text = rewrite(text, config, counts, rel);
  }
  if (text !== original) planned.set(rel, text);
}

let assetsChanged = 0;
for (const asset of assets) {
  const data = fs.readFileSync(asset.from);
  const same = fs.existsSync(asset.to) && fs.readFileSync(asset.to).equals(data);
  if (!same) {
    assetsChanged++;
    if (!args.check && errors.length === 0) {
      fs.mkdirSync(path.dirname(asset.to), { recursive: true });
      fs.writeFileSync(asset.to, data);
    }
  }
}

if (errors.length) {
  console.error(`dozo-brand: ${errors.length} rule failure(s), nothing written:`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(2);
}

if (!args.check) {
  for (const [rel, text] of planned) fs.writeFileSync(path.join(root, rel), text);
}

const verb = args.check ? "would change" : "changed";
console.log(`brand ${config.from} -> ${config.to}${args.check ? " (dry run)" : ""}, root ${root}`);
console.log(`files scanned: ${scanned}, ${verb}: ${planned.size + assetsChanged}`);
console.log("replacements:");
const keys = Object.keys(counts).sort();
for (const key of keys) console.log(`  ${key}: ${counts[key]}`);
if (keys.length === 0) console.log("  none");
console.log(
  `hooks: anchored ${anchoredApplied} applied, ${anchoredAlready} already applied; assets ${assetsChanged} copied`,
);
