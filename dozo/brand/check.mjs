#!/usr/bin/env node
/**
 * Leak gate: fails when the old brand is still user-visible in an applied tree.
 *
 *   node dozo/brand/check.mjs --root <dir> [--launch] [--config <file>]
 *
 * Exit 0 when clean, 2 with a `path:line: match` list (first 50) plus a total otherwise.
 * `--launch` adds the checks that only matter before real users: placeholder domains and
 * repository owners, and the `allow.phrases` entries not marked `permanent: true` (upstream image names).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  escapeRe,
  fail,
  inScope,
  isBinary,
  listFiles,
  literalApplies,
  loadConfig,
  parseArgs,
  urlRe,
  visibleLeaks,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["launch"]);
if (!args.root) fail("usage: check.mjs --root <dir> [--launch] [--config <file>]");
const root = path.resolve(args.root);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
const config = loadConfig(args.config ?? DEFAULT_CONFIG);

// The brand word is case-sensitive (identifiers like rakazo_app stay); URL needles are not.
const words = [config.from, ...Object.keys(config.variants), ...config.leakWords]
  .map(escapeRe)
  .join("|");
const wordRe = new RegExp(`\\b(?:${words})\\b`, "g");
const needleRe = (() => {
  const parts = [
    ...config.leak.map((text) => urlRe(text, "").source),
    ...Object.keys(config.urls).map((text) => urlRe(text, "").source),
  ];
  return parts.length ? new RegExp(parts.join("|"), "gi") : null;
})();
// The new brand followed by a public TLD is a domain the fork may not own (`Rakazo.com` renamed by
// the blanket rule). Only the URL map's targets are ours; the placeholder `.example` is no public TLD.
const TLDS = "com|net|org|io|ai|app|dev|co|xyz|me|cloud|info";
const domainRe = new RegExp(`\\b${escapeRe(config.to)}\\.(?:${TLDS})\\b`, "gi");
const ownDomains = Object.values(config.urls).map(escapeRe);
const ownDomainRe = ownDomains.length ? new RegExp(ownDomains.join("|"), "gi") : null;
// Phrases the gate ignores: what apply keeps on purpose plus the gate-only allow-list.
const allowed = [...config.keep, ...config.allow.phrases].map((entry) => escapeRe(entry.text));
const allowedRe = allowed.length ? new RegExp(allowed.join("|"), "g") : null;

// A URL target glued to the next word means a rewrite ate part of another token
// (`dozo.exampleputerOwner`), which the old-brand needles cannot see any more.
const glued = Object.values(config.urls)
  .filter((value) => /\w$/.test(value))
  .map((value) => `${escapeRe(value)}\\w`);
const gluedRe = glued.length ? new RegExp(glued.join("|"), "g") : null;

// Lowercase brand in places a person can read: a bare text node, a download file name, a
// quoted string that is exactly the name (client names, user names), a .po entry.
const bareRe = /^\s*rakazo\s*$|>\s*rakazo\s*</g;
const fileNameRe = /\brakazo[-.][^"'`]*\.(?:zip|jsonl|apk|csv|pdf|ics|ipa|dmg|exe)\b/g;
const quotedRe = /(["'`])(?:rakazo|Rakazo[A-Za-z]+)\1/g;
const poRe = /\brakazo\b/g;

// Placeholders and upstream images, checked with --launch only.
const launchRe = /\bdozo\.example\b|\bOWNER\/dozo\b/g;
// A `permanent` phrase (an HMAC input that can never be renamed) is never a launch blocker.
const launchPhrases = config.allow.phrases.filter((entry) => !entry.permanent).map((entry) => escapeRe(entry.text));
const launchPhraseRe = launchPhrases.length ? new RegExp(launchPhrases.join("|"), "g") : null;

const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|svg|woff2?|ttf|otf|mp4|webm|lottie|riv)$/i;

const found = [];
let scanned = 0;
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

for (const rel of listFiles(root)) {
  if (!inScope(config, rel) || config.allowFilesRe.some((re) => re.test(rel))) continue;
  const buffer = fs.readFileSync(path.join(root, rel));
  if (IMAGE_RE.test(rel) && !config.assets[rel]) {
    // Images are not text: anything not replaced through the asset map must be reviewed once.
    if (!config.allowImagesRe.some((re) => re.test(rel))) {
      found.push(`${rel}: image neither mapped in "assets" nor reviewed in "allow.images"`);
    }
    if (isBinary(buffer) || !rel.endsWith(".svg")) continue;
  } else if (isBinary(buffer)) continue;
  scanned++;
  const isPo = rel.endsWith(".po");
  const lowercaseAllowed = config.allowLowercaseRe.some((re) => re.test(rel));
  const lines = buffer.toString("utf8").split("\n");
  // Same for every line of the file, so built once per file (order matters for the first-hit report).
  const fileChecks = [wordRe, needleRe, gluedRe, bareRe, fileNameRe];
  if (!lowercaseAllowed) fileChecks.push(quotedRe);
  for (let i = 0; i < lines.length; i++) {
    const line = allowedRe ? lines[i].replace(allowedRe, (m) => " ".repeat(m.length)) : lines[i];
    // .po headers ("Project-Id-Version: ...") are metadata; entries are what the UI shows.
    const checks = isPo && /^(?:msgid|msgstr|")/.test(line) && !/^"[A-Z][\w-]*: /.test(line) ? [...fileChecks, poRe] : fileChecks;
    for (const re of checks) {
      for (const match of re ? line.matchAll(re) : []) found.push(`${rel}:${i + 1}: ${match[0]}`);
    }
    const own = ownDomainRe ? line.replace(ownDomainRe, (m) => " ".repeat(m.length)) : line;
    for (const match of own.matchAll(domainRe)) found.push(`${rel}:${i + 1}: ${match[0]} (brand domain)`);
    // Readable lowercase/all-caps brand and social profile links (see VISIBLE_PATTERNS in lib.mjs).
    // One finding per line is enough; the first (most specific) pattern names it.
    for (const hit of visibleLeaks(line, { lowercaseOk: lowercaseAllowed }).slice(0, 1)) {
      found.push(`${rel}:${i + 1}: ${hit.text} (${hit.pattern})`);
    }
    for (const literal of config.literals) {
      if (literalApplies(literal, rel) && line.includes(literal.find)) {
        found.push(`${rel}:${i + 1}: ${literal.find} (literal rule not applied)`);
      }
    }
    if (args.launch) {
      for (const re of [launchRe, launchPhraseRe]) {
        for (const match of re ? lines[i].matchAll(re) : []) {
          found.push(`${rel}:${i + 1}: ${match[0]} (launch placeholder)`);
        }
      }
    }
  }
}

// Mapped assets must be our files, byte for byte.
for (const [dest, source] of Object.entries(config.assets)) {
  const file = path.join(root, dest);
  const ours = path.join(config.dir, "assets", source);
  if (!fs.existsSync(file)) found.push(`${dest}: mapped asset missing from the tree`);
  else if (!fs.existsSync(ours) || sha(fs.readFileSync(file)) !== sha(fs.readFileSync(ours))) {
    found.push(`${dest}: differs from dozo/brand/assets/${source} (upstream image still in place?)`);
  }
}

if (found.length === 0) {
  console.log(`leak gate clean: ${scanned} files scanned${args.launch ? " (launch checks on)" : ""}`);
  process.exit(0);
}
for (const line of found.slice(0, 50)) console.error(line);
const capped = found.length > 50 ? " (list capped at 50)" : "";
console.error(`${found.length} leak(s) of the old brand in ${scanned} files scanned${capped}`);
process.exit(2);
