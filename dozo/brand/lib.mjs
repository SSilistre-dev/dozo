// Shared by apply.mjs and check.mjs: config loading, file selection, the text rewrite.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "brand.json");

export function fail(message) {
  console.error(`dozo-brand: ${message}`);
  process.exit(2);
}

export function parseArgs(argv, flags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (flags.includes(name)) out[name] = true;
    else if (["root", "config"].includes(name))
      out[name] = argv[++i] ?? fail(`--${name} needs a value`);
    else fail(`unknown option ${arg}`);
  }
  return out;
}

export function loadConfig(file = DEFAULT_CONFIG) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read config ${file}: ${error.message}`);
  }
  if (!raw.from || !raw.to) fail("config needs `from` and `to`");
  const list = (value) => value ?? [];
  const config = {
    from: raw.from,
    to: raw.to,
    variants: raw.variants ?? {},
    urls: raw.urls ?? {},
    include: list(raw.include),
    exclude: list(raw.exclude),
    keep: list(raw.keep),
    allow: { files: list(raw.allow?.files), phrases: list(raw.allow?.phrases) },
    leak: list(raw.leak),
    anchored: list(raw.anchored),
    assets: raw.assets ?? {},
    dir: path.dirname(path.resolve(file)),
  };
  if (config.include.length === 0) fail("config `include` is empty");
  for (const [name, entries] of [
    ["exclude", config.exclude],
    ["keep", config.keep],
    ["allow.files", config.allow.files],
    ["allow.phrases", config.allow.phrases],
  ]) {
    if (entries.some((entry) => !entry.reason)) fail(`every ${name} entry needs a reason`);
  }
  config.includeRe = config.include.map(globToRegExp);
  config.excludeRe = config.exclude.map((entry) => globToRegExp(entry.glob));
  config.allowFilesRe = config.allow.files.map((entry) => globToRegExp(entry.glob));
  return config;
}

export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Regular files under root as posix relative paths; never descends into .git or node_modules. */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

export const inScope = (config, rel) =>
  config.includeRe.some((re) => re.test(rel)) && !config.excludeRe.some((re) => re.test(rel));

// ponytail: NUL-byte sniff on the first 8 KB; a UTF-16 text file would count as binary and be skipped.
export const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

export const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites one file's text: URL map (longest key first), then the whole-word name. */
export function rewrite(text, config, counts) {
  const bump = (key, n) => {
    if (n) counts[key] = (counts[key] ?? 0) + n;
  };
  for (const key of Object.keys(config.urls).sort((a, b) => b.length - a.length)) {
    const parts = text.split(key);
    if (parts.length > 1) {
      bump(`url ${key}`, parts.length - 1);
      text = parts.join(config.urls[key]);
    }
  }
  const words = { [config.from]: config.to, ...config.variants };
  const names = Object.keys(words).sort((a, b) => b.length - a.length);
  const kept = config.keep.map((entry) => escapeRe(entry.text));
  const re = new RegExp([...kept, `\\b(?:${names.map(escapeRe).join("|")})\\b`].join("|"), "g");
  return text.replace(re, (match) => {
    if (!(match in words)) return match;
    bump(match === config.from ? "blanket" : `variant ${match}`, 1);
    return words[match];
  });
}
