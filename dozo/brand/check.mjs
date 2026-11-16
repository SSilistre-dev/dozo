#!/usr/bin/env node
/**
 * Leak gate: fails when the old brand is still user-visible in an applied tree.
 *
 *   node dozo/brand/check.mjs --root <dir> [--config <file>]
 *
 * Exit 0 when clean, 2 with a `path:line: match` list (first 50) plus a total otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  escapeRe,
  fail,
  inScope,
  isBinary,
  listFiles,
  loadConfig,
  parseArgs,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), []);
if (!args.root) fail("usage: check.mjs --root <dir> [--config <file>]");
const root = path.resolve(args.root);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
const config = loadConfig(args.config ?? DEFAULT_CONFIG);

// The brand word is case-sensitive (identifiers like rakazo_app stay); URL needles are not.
const words = [config.from, ...Object.keys(config.variants)].map(escapeRe).join("|");
const wordRe = new RegExp(`\\b(?:${words})\\b`, "g");
const needles = [...config.leak, ...Object.keys(config.urls)].map(escapeRe);
const needleRe = needles.length ? new RegExp(needles.join("|"), "gi") : null;
// Phrases the gate ignores: what apply keeps on purpose plus the gate-only allow-list.
const allowed = [...config.keep, ...config.allow.phrases].map((entry) => escapeRe(entry.text));
const allowedRe = allowed.length ? new RegExp(allowed.join("|"), "g") : null;

const found = [];
let scanned = 0;
for (const rel of listFiles(root)) {
  if (!inScope(config, rel) || config.allowFilesRe.some((re) => re.test(rel))) continue;
  const buffer = fs.readFileSync(path.join(root, rel));
  if (isBinary(buffer)) continue;
  scanned++;
  const lines = buffer.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = allowedRe ? lines[i].replace(allowedRe, (m) => " ".repeat(m.length)) : lines[i];
    for (const re of [wordRe, needleRe]) {
      for (const match of re ? line.matchAll(re) : []) found.push(`${rel}:${i + 1}: ${match[0]}`);
    }
  }
}

if (found.length === 0) {
  console.log(`leak gate clean: ${scanned} files scanned`);
  process.exit(0);
}
for (const line of found.slice(0, 50)) console.error(line);
const capped = found.length > 50 ? " (list capped at 50)" : "";
console.error(`${found.length} leak(s) of the old brand in ${scanned} files scanned${capped}`);
process.exit(2);
