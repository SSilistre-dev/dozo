// Shared by apply.mjs and check.mjs: config loading, file selection, the text rewrite, and the
// line scanner behind the leak gate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "brand.json");

export function fail(message) {
  console.error(`dozo-brand: ${message}`);
  process.exit(2);
}

/** An unexpected error (unreadable file, a directory where a file is expected) is a failed run, exit 2, not a stack trace. */
export const guard = () => process.on("uncaughtException", (error) => fail(`unexpected error: ${error.message}`));

/** `flags` are boolean options; `--root` and `--config` take a value. Anything else, a repeat, or a missing value exits 2. */
export function parseArgs(argv, flags) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (Object.hasOwn(out, name)) fail(`${arg} given twice`);
    if (flags.includes(name)) out[name] = true;
    else if (["root", "config"].includes(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
      out[name] = value;
    } else fail(`unknown option ${arg}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";
const isTextList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);

// Entry lists: name -> required text fields. Every entry also needs a `reason`.
const ENTRY_FIELDS = {
  exclude: ["glob"],
  keep: ["text", "files"],
  "allow.phrases": ["text", "files"],
  "allow.text": ["file", "text"],
  "allow.paths": ["glob"],
  "allow.binary": ["glob"],
  literals: ["find", "replace"],
};
const ANCHORED_FIELDS = "anchored rule needs file, find, replace and reason";

export function loadConfig(file = DEFAULT_CONFIG) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read config ${file}: ${error.message}`);
  }
  const need = (ok, message) => ok || fail(`config: ${message}`);
  need(isObject(raw), "must be a JSON object");
  const KEYS = ["from", "to", "variants", "urls", "include", "exclude", "keep", "allow", "literals", "leak", "leakWords", "anchored", "assets"];
  for (const key of Object.keys(raw)) need(KEYS.includes(key), `unknown key ${key}`);
  need(isText(raw.from) && isText(raw.to), "needs `from` and `to` (non-empty strings)");
  need(!raw.to.includes(raw.from), "`to` must not contain `from`, a re-run would rename again");
  const allow = raw.allow ?? {};
  need(isObject(allow), "`allow` must be an object");
  need(allow.images === undefined, "`allow.images` was renamed `allow.binary` (it covers fonts, media and documents as well as images): rename the key");
  for (const key of Object.keys(allow)) need(Object.keys(ENTRY_FIELDS).includes(`allow.${key}`), `unknown key allow.${key}`);

  const maps = {};
  for (const name of ["variants", "urls", "assets"]) {
    const value = raw[name] ?? {};
    need(isObject(value), `\`${name}\` must be an object`);
    for (const [key, target] of Object.entries(value)) {
      need(isText(key) && isText(target), `${name} entries need a non-empty key and a non-empty string value: ${JSON.stringify(key)}`);
      // A target holding its own key would be rewritten again on a re-run.
      if (name !== "assets") need(!target.toLowerCase().includes(key.toLowerCase()), `${name} target contains its key: ${key}`);
    }
    maps[name] = value;
  }
  for (const name of ["include", "leak", "leakWords"]) {
    need(raw[name] === undefined || (Array.isArray(raw[name]) && raw[name].every(isText)), `\`${name}\` must be a list of non-empty strings`);
  }
  need(raw.include?.length > 0, "`include` is empty");

  const lists = {};
  for (const [name, fields] of Object.entries(ENTRY_FIELDS)) {
    const [group, sub] = name.split(".");
    const value = (sub ? allow[sub] : raw[group]) ?? [];
    need(Array.isArray(value), `\`${name}\` must be a list`);
    for (const entry of value) {
      need(isObject(entry), `every ${name} entry must be an object`);
      need(isText(entry.reason), `every ${name} entry needs a reason`);
      for (const field of fields) {
        if (field === "files") need(isTextList(entry.files), `${name} entry needs a non-empty \`files\` list of globs: ${JSON.stringify(entry)}`);
        else if (field === "replace") need(typeof entry.replace === "string", `literal needs find and replace: ${JSON.stringify(entry)}`);
        else need(isText(entry[field]), `${name} entry needs ${field}: ${JSON.stringify(entry)}`);
      }
      if (name === "allow.paths") need(!/[*?]/.test(entry.glob), `allow.paths lists exact names, not globs (a wildcard would pass a future file): ${JSON.stringify(entry.glob)}`);
      if (name === "allow.text") need(entry.count === undefined || (Number.isInteger(entry.count) && entry.count >= 1), `allow.text count must be a whole number of 1 or more: ${JSON.stringify(entry)}`);
    }
    lists[name] = value;
  }
  for (const literal of lists.literals) {
    need(!literal.replace.includes(literal.find), `literal replace contains find, a re-run would rewrite again: ${JSON.stringify(literal.find)}`);
    need(literal.files === undefined || isTextList(literal.files), `literal files must be a non-empty list of globs: ${JSON.stringify(literal.find)}`);
  }

  need(Array.isArray(raw.anchored ?? []), "`anchored` must be a list");
  for (const rule of raw.anchored ?? []) {
    need(isObject(rule) && isText(rule.file) && isText(rule.find) && typeof rule.replace === "string" && isText(rule.reason), `${ANCHORED_FIELDS}: ${JSON.stringify(rule)}`);
    // An empty replace is "present" in every file, so a missing find could never be told from an
    // applied rule; a replace holding find would match again on a re-run. Neither is a rule.
    need(rule.replace !== "" && !rule.replace.includes(rule.find), `anchored rule (${rule.reason}): empty replace or replace contains find, so a re-run could not tell applied from not applied: ${JSON.stringify(rule.find)}`);
    need(rule.requires === undefined || (Array.isArray(rule.requires) && rule.requires.every(isText)), `anchored rule (${rule.reason}): requires must be a list of paths`);
  }

  const globs = (list) => list.map((entry) => globToRegExp(entry.glob));
  const config = {
    from: raw.from,
    to: raw.to,
    ...maps,
    include: raw.include,
    leak: raw.leak ?? [],
    leakWords: raw.leakWords ?? [],
    anchored: raw.anchored ?? [],
    exclude: lists.exclude,
    keep: lists.keep,
    allow: { phrases: lists["allow.phrases"], text: lists["allow.text"], paths: lists["allow.paths"], binary: lists["allow.binary"] },
    literals: lists.literals,
    dir: path.dirname(path.resolve(file)),
  };
  config.includeRe = config.include.map(globToRegExp);
  config.excludeRe = globs(config.exclude);
  config.allowPathsRe = globs(config.allow.paths);
  config.allowBinaryRe = globs(config.allow.binary);
  for (const entry of [...config.keep, ...config.allow.phrases]) entry.filesRe = entry.files.map(globToRegExp);
  for (const literal of config.literals) literal.filesRe = (literal.files ?? []).map(globToRegExp);
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

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

// Runtime state, never source: the stack's bind-mounted data/ (root-owned on Linux, unreadable) at the
// top of a staged tree, and a staged copy sitting inside a repository root.
const RUNTIME_DIRS = new Set(["data", "dozo/.stage"]);

/**
 * Regular files under root as posix relative paths; never descends into .git, node_modules or
 * RUNTIME_DIRS. Symlinks are neither read nor rewritten: pass `links` to collect their paths.
 */
export function listFiles(root, links = []) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!RUNTIME_DIRS.has(rel)) walk(rel); }
      else if (entry.isFile()) out.push(rel);
      else if (entry.isSymbolicLink()) links.push(rel);
    }
  };
  walk("");
  return out.sort();
}

export const inScope = (config, rel) =>
  config.includeRe.some((re) => re.test(rel)) && !config.excludeRe.some((re) => re.test(rel));

// Binary types the gate knows how to treat: images (mapped in `assets` or reviewed in
// `allow.binary`), fonts, media and documents. Only `.svg` is also text. A NUL byte in any other
// in-scope file (UTF-16 text) is reported, never skipped.
export const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|svg|tiff?|heic|jfif|jp2|apng|pdf|woff2?|ttf|otf|eot|mp4|webm|lottie|riv)$/i;
export const isSvg = (rel) => /\.svg$/i.test(rel);

// ponytail: NUL-byte sniff on the first 8 KB.
export const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

// ignoreBOM keeps a leading BOM in the string so a rewrite does not drop it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `{ binary: true }` or `{ text }`; exits 2 naming the file when it cannot be read or is not UTF-8. A known binary type (not `.svg`) is never decoded. */
export function readFile(root, rel) {
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(root, rel));
  } catch (error) {
    fail(`cannot read ${rel}: ${error.message}`);
  }
  if ((BINARY_EXT.test(rel) && !isSvg(rel)) || isBinary(buffer)) return { binary: true, buffer };
  try {
    return { text: utf8.decode(buffer) };
  } catch {
    return fail(`${rel} is not valid UTF-8 (convert it, or exclude it with a reason): it would be corrupted by a rewrite`);
  }
}

/** Replace the file in one step, keeping its mode: a reader sees the old or the new content, never half. A failed write removes its temp file. */
export function writeAtomic(file, data) {
  const tmp = `${file}.dozo-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------------------------

export const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A literal applies to every file in scope, or only to the globs in its `files`. */
export const literalApplies = (literal, rel) =>
  literal.filesRe.length === 0 || literal.filesRe.some((re) => re.test(rel));

/** How often a reviewed `allow.text` entry's text occurs in `text` (whole phrases only). */
export const countText = (entry, text) => (text.match(phraseRe(entry.text)) ?? []).length;

/** The number of occurrences an `allow.text` entry stands for; a new one in the file is a new leak. */
export const expectedCount = (entry) => entry.count ?? 1;

/** `keep` and `allow.phrases` entries are limited to their `files`. */
export const entryApplies = (entry, rel) => entry.filesRe.some((re) => re.test(rel));

/**
 * A reviewed phrase matches as a whole: not glued to a word or hyphen on either side, so
 * `Rakazo.icon` does not cover `Rakazo.icons` and an image name does not cover `…rakazo-evil/img`.
 */
export const phraseRe = (text, flags = "g") =>
  new RegExp(
    (/^\w/.test(text) ? "(?<![\\w-])" : "") + escapeRe(text) + (/\w$/.test(text) ? "(?![\\w-])" : ""),
    flags,
  );

/**
 * URL keys match as a whole: no word character, dot or hyphen before (`getrakazo.com`,
 * `status.rakazo.com` are other hosts) and none after (`rakazo.com` must not eat the start of
 * `rakazo.computerOwner`), nor `&` or `=` (a store link with more query parameters is not the key).
 * Subdomains that are ours are listed as keys of their own. Shared by apply and the leak gate.
 */
export const urlRe = (key, flags = "g") =>
  new RegExp(
    (/^\w/.test(key) ? "(?<![\\w.-])" : "") + escapeRe(key) + (/\w$/.test(key) ? "(?![\\w&=-])" : ""),
    flags,
  );

/**
 * Rewrites one file's text: literals, URL map (longest key first, any capitalisation, the mapped
 * target written exactly), then the whole-word name. `rel` selects the literals and the `keep`
 * phrases that are limited to some files.
 */
export function rewrite(text, config, counts, rel = "") {
  const bump = (key, n) => {
    if (n) counts[key] = (counts[key] ?? 0) + n;
  };
  for (const literal of config.literals) {
    if (!literalApplies(literal, rel)) continue;
    const parts = text.split(literal.find);
    if (parts.length > 1) {
      bump(`literal ${literal.find}`, parts.length - 1);
      text = parts.join(literal.replace);
    }
  }
  for (const key of Object.keys(config.urls).sort((a, b) => b.length - a.length)) {
    let n = 0;
    text = text.replace(urlRe(key, "gi"), () => (n++, config.urls[key]));
    bump(`url ${key}`, n);
  }
  const words = { [config.from]: config.to, ...config.variants };
  const names = Object.keys(words).sort((a, b) => b.length - a.length);
  const kept = config.keep.filter((entry) => entryApplies(entry, rel)).map((entry) => phraseRe(entry.text).source);
  const re = new RegExp([...kept, `\\b(?:${names.map(escapeRe).join("|")})\\b`].join("|"), "g");
  return text.replace(re, (match) => {
    if (!(match in words)) return match;
    bump(match === config.from ? "blanket" : `variant ${match}`, 1);
    return words[match];
  });
}

// ---------------------------------------------------------------------------------------------
// Leak gate scanner (check.mjs). Rule: every case-insensitive occurrence of the old brand word in
// an applied tree is a leak, unless it sits inside one of the SHAPES below (a technical identifier
// that stays on purpose) or inside a reviewed phrase (`keep`, `allow.phrases`, `allow.text`).
// ---------------------------------------------------------------------------------------------

const TLDS = "com|net|org|io|ai|app|dev|co|xyz|me|cloud|info|tech|tools|so|sh|ly|gg|chat|site|online|store";

/**
 * Technical identifier shapes: the whole token that holds the old name, as the tree contains it.
 * Case-sensitive; the brand is never matched as a word of its own here (`rakazo.`, `rakazo-powered`,
 * `#rakazo` match nothing). Add a row only for a shape upstream really uses, with its reason.
 * A row that lists `stems` is a closed list: each stem is one name the tree really uses, and
 * `apply --strict` fails on a row or a stem that matches nothing. `ok(line, match)` narrows a row to
 * the code-like places where its token stands. Samples for every row live in brand.gate.test.mjs.
 */
export const SHAPES = [];

/** A row from a closed list of stems; every stem is a capture group, in `stems` order, so a match says which stem it was. */
function addStems(name, reason, stems, make, ok) {
  const ordered = [...new Set(stems)].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const group = `(?:${ordered.map((stem) => `(${escapeRe(stem)})`).join("|")})`;
  SHAPES.push({ name, reason, stems: ordered, re: new RegExp(make(group), "g"), ok });
}

// Prose is a plain word, spaces, the token, spaces, a lowercase word: `Try the rakazo-browser app`.
const inProse = (line, m) => /[A-Za-z][ \t]+$/.test(line.slice(0, m.index)) && /^[ \t]+[a-z]/.test(line.slice(m.index + m[0].length));
const notProse = (line, m) => !inProse(line, m);

const KEYWORD_BEFORE = /\b(?:new|class|type|interface|function|const|let|var|typeof)[ \t]+$/;

/**
 * A PascalCase or camelCase token that starts with the brand is an identifier only where code puts
 * one: after `.`, after a declaring keyword, as a JSX tag or type argument (`<`), alone in a string,
 * before `(` or `.name`, or in a slot (object key, parameter, type annotation, import list) that
 * follows no word and is followed by `: = ? | & , ; ) ] } >`. Between plain words, in JSX text and
 * inside a string with spaces it is a leak. Limit: a parenthesised or colon-ended name in prose
 * (`(RakazoPro)`, `RakazoBot: hi`) reads as a slot.
 */
function camelInCode(line, m) {
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length);
  if (/[\w)\]?]\.$/.test(before) || KEYWORD_BEFORE.test(before) || before.endsWith("<")) return true;
  if (/^(?:\(|\.[A-Za-z_$])/.test(after)) return true;
  const quote = before.at(-1);
  if (quote && "\"'`".includes(quote) && after[0] === quote) return true;
  const lead = before.trimEnd();
  const afterText = /\w[ \t]+$/.test(before) || (/[>"'`]$/.test(lead) && !lead.endsWith("=>"));
  return !afterText && /^[ \t]*[:=?|&,;)\]}>]/.test(after);
}

/** A dotted key stands in code: inside quotes, in a URL or path, or as the name of an `=` assignment. */
const dottedInCode = (line, m) => /["'`/]$/.test(line.slice(0, m.index)) || /^[\w.-]*=/.test(line.slice(m.index + m[0].length));

SHAPES.push({ name: "package-scope", re: /@rakazo\//g, reason: "workspace package scope @rakazo/*: imports and package names" });
SHAPES.push({ name: "env-name", re: /(?<![A-Za-z0-9])RAKAZO(?=_)/g, reason: "RAKAZO_* environment variables, macros and __RAKAZO_X__ globals" });
SHAPES.push({ name: "snake-name", re: /(?<![A-Za-z0-9/@])rakazo_/g, reason: "snake_case names: metadata keys, secret-store keys, C symbols (rakazo_xcapture_*); not after / or @, where it is a profile handle" });
SHAPES.push({ name: "camel-name", re: /(?<![A-Za-z0-9_/@])[a-z_]*[Rr]akazo(?=[A-Z])\w*/g, ok: camelInCode, reason: "camelCase and PascalCase identifiers (RakazoDesktop, rakazoScreen, isRakazoContainer) in a code position; not after / or @, where it is a profile handle" });
SHAPES.push({ name: "template-name", re: /(?<![A-Za-z0-9])rakazo-(?=\$)/g, reason: "generated names such as `rakazo-${randomUUID()}` for containers and temp files" });
SHAPES.push({ name: "namespaced-key", re: /(?<![A-Za-z0-9])rakazo:(?=[\w$/])/g, reason: "storage and id namespaces (rakazo:thread:1) and the rakazo:// URL scheme" });
addStems(
  "dotted-key",
  "dotted attribute, label, metadata and storage keys (rakazo.botId) from a closed list, inside quotes, a URL or path, or before `=`; a public TLD is caught before this",
  ["activity", "agent", "bot", "botId", "botsSidebarDensity", "clientIp", "composerBindings", "composerDraft", "composerEnterToSend", "composerNonce", "composerSend", "computerOwner", "control", "egressProbe", "githubStarPrompt", "invalid", "loadRemoteImages", "logOutFailed", "managed", "mountSources", "passkey", "pi", "responseStreaming", "routine", "run", "showToolActivity", "signed", "signedInUser", "spaceId", "test", "uiAppearance", "uiLocale", "workspaceId"],
  (alt) => String.raw`(?<![A-Za-z0-9])rakazo\.${alt}(?![A-Za-z0-9_])`,
  dottedInCode,
);
SHAPES.push({ name: "header", re: /(?<![\w-])x-rakazo-/gi, reason: "x-rakazo-* HTTP headers" });
SHAPES.push({ name: "data-attribute", re: /(?<![\w-])data-rakazo-/g, reason: "data-rakazo-* DOM attributes" });
addStems(
  "css-name",
  "CSS classes, keyframes and custom properties of the avatars and the boot screen",
  ["organic", "bot-avatar", "logo-avatar", "group-avatar", "avatar-breathe", "avatar-spin", "app-boot--"],
  (alt) => String.raw`(?<![\w-])(?:--|\.)?rakazo-${alt}[\w-]*`,
  notProse,
);
addStems(
  "dom-event",
  "postMessage and DOM event types between the page frame and the host",
  ["app", "page", "mention", "mcp-signin", "save"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}:`,
);
addStems(
  "binary-name",
  "executables, libraries and directories installed in the computer image",
  ["browser", "page-browser", "focus-or-launch", "computer", "local-bin", "proxy", "terminal", "xcapture", "home"],
  (alt) => String.raw`(?<![\w-])(?:lib)?rakazo-${alt}(?![\w-])`,
  notProse,
);
addStems(
  "service-name",
  "compose services, queues, packages, runtimes and the .po catalog project id",
  ["api", "api-jobs", "worker", "web", "realtime", "updater", "sandboxes", "sandbox-supervisor", "desktop", "desktop-stack", "emulator", "third-party-emulator", "wuying", "prod", "exec"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}(?![\w-])`,
  notProse,
);
addStems(
  "persisted-key",
  "stored keys, window and channel names, cache names and format ids that persisted data refers to",
  ["instance-theme", "home-storage", "history", "build-id", "content-encryption", "content-security-policy", "pwa-manifest", "pwa-service-worker", "storage-migration", "export-list", "account-export", "turn", "turn-document", "oauth", "mcp-oauth", "mcp-packages", "sso-oauth", "plugin-connect", "app-connect", "slack-install", "bot-id"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}(?![\w-])`,
  notProse,
);
addStems(
  "name-prefix",
  "prefixes of temp directories and generated ids: followed by a quote or a generated part",
  ["account-import", "account-import-archive", "claude-code-request", "computer", "migrations", "say", "shell", "snapshot", "teardown", "turn", "workspace", "workspace-archive", "balance", "bot", "ab", "mcp"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}-(?=["'\`$[{])`,
);
addStems(
  "process-marker",
  "argv markers matched by pkill, probe names and the docker bridge prefix rakazo-c",
  ["coding-agent-probe", "background-idle", "background-launch", "background-probe", "cancel-run-work", "write", "egress-probe", "c", "cprobe"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}(?![\w-])`,
  notProse,
);
addStems(
  "memory-entity",
  "entity ids sent to the memory provider (rakazo-space/<id>)",
  ["bot", "space"],
  (alt) => String.raw`(?<![\w-])rakazo-${alt}/(?=\$)`,
);
SHAPES.push({ name: "image-name", re: /(?<![\w/.-])rakazo\\?\/computer(?![\w-])/g, reason: "local computer image name rakazo/computer, also as an escaped regex" });
addStems(
  "kdf-context",
  "key-derivation and AAD context strings: changing them breaks decryption of stored data",
  ["content", "content-master-key", "search", "space-key"],
  (alt) => String.raw`(?<![\w/-])rakazo/${alt}/v1`,
);
SHAPES.push({ name: "hidden-name", re: /(?<![\w-])\.rakazo(?:-command-env|-executables\.json|(?=\/|["'`]))/g, reason: "hidden files and directories inside the computer workspace" });
// A part of a path that is free text must not carry the name, in any capitalisation: the row would
// swallow it and hide it from the gate (`/opt/rakazo-pro/rakazo-home`). Only the directory `rakazo`
// itself (followed by `/`) may stand in the middle.
const NAMED = "[Rr][Aa][Kk][Aa][Zz][Oo]";
const PLAIN_PART = String.raw`(?![\w.$-]*${NAMED})[\w.$-]+`;
// A path token is closed on the right: the stem is what the tree really puts after the name, and any
// other letter, digit, `_` or `-` makes it another path (`/opt/rakazo-pro`). The bare directory
// (`/tmp/rakazo`) is the one tail with no stem: a `/`, a quote, a space, punctuation, a full stop that
// no word follows, or the line end must follow, so `/etc/rakazo.conf` is a leak. The one file named rakazo.* in the tree has its own row below.
addStems(
  "fs-path",
  "absolute paths inside the computer image (/tmp/rakazo/*, /usr/local/bin/rakazo-*), each tail from a closed list",
  ["-background-", "-browser", "-cache", "-chrome", "-chrome-XXXXXX", "-command-", "-command-env", "-computer", "-computer-control", "-focus-or-launch", "-home", "-local-bin", "-nss", "-page-browser", "-page-browser-", "-page-input-", "-prepare", "-proxy", "-terminal", "-user-env", "-worker-health", "-workspace-", "-workspace-archive-", "-xcapture"],
  (alt) => String.raw`(?<![\w.])\/(?:tmp|etc|run|var|usr|home|build|opt)(?:\/(?:rakazo(?=\/)|${PLAIN_PART}))*\/(?:\.|lib)?rakazo(?:${alt}(?![\w-])|(?=[/\s"'\x60,)\];:<>}]|\.(?![\w-])|$))`,
);
SHAPES.push({ name: "policy-path", re: /(?<![\w.])\/etc\/brave\/policies\/managed\/rakazo\.json(?![\w-]|\.[\w-])/g, reason: "the browser policy file written into the computer image" });
addStems(
  "shell-path",
  "relative shell paths ($dir/rakazo-proxy.json, ./rakazo-browser), each tail from a closed list",
  ["-browser", "-proxy", "-write"],
  (alt) => String.raw`(?:\$(?![\w]*${NAMED})\w+|~|\.{1,3})\/\.?rakazo${alt}(?![\w-])`,
);
SHAPES.push({ name: "windows-path", re: /(?<=\\)rakazo(?=\\)/g, reason: "profile directory on a Windows computer" });
SHAPES.push({ name: "dev-database", re: new RegExp(String.raw`\/\/rakazo:rakazo@(?![\w.:]*${NAMED})[\w.:]+\/rakazo`, "g"), reason: "local development database URL" });

/** The matches of one row in one line that stand where the row allows them. */
export const shapeMatches = (shape, line) => [...line.matchAll(shape.re)].filter((m) => !shape.ok || shape.ok(line, m));

/** The rows, and the stems of the closed rows, that match nothing in `texts` (the staged tree's text): `[{ shape, stem? }]`. */
export function deadShapes(texts) {
  const rows = new Set();
  const stems = new Set();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!/rakazo/i.test(line)) continue;
      for (const shape of SHAPES) {
        for (const m of shapeMatches(shape, line)) {
          rows.add(shape.name);
          if (shape.stems) stems.add(`${shape.name}\0${shape.stems[m.slice(1).findIndex((group) => group !== undefined)]}`);
        }
      }
    }
  }
  const dead = [];
  for (const shape of SHAPES) {
    if (!rows.has(shape.name)) dead.push({ shape: shape.name });
    else for (const stem of shape.stems ?? []) if (!stems.has(`${shape.name}\0${stem}`)) dead.push({ shape: shape.name, stem });
  }
  return dead;
}

/** A string that is exactly one PascalCase brand name is a client or operation name sent to a third party. */
const QUOTED_NAME = /(["'`])Rakazo[A-Z][A-Za-z0-9]*\1/g;

const blank = (text, re) => text.replace(re, (match) => " ".repeat(match.length));

/**
 * `scan(rel, line)` returns `[{ text, label?, start }]` for one line of file `rel`, de-duplicated
 * (a finding that overlaps an earlier, longer one is dropped), in line order. `scanPath(rel)`
 * lists the path segments that carry the old name.
 */
export function buildScanner(config) {
  const alt = (list, flags = "gi") => (list.length ? new RegExp(list.join("|"), flags) : null);
  const phrases = [...config.keep, ...config.allow.phrases].map((entry) => ({ re: phraseRe(entry.text), entry }));
  const reviewed = config.allow.text.map((entry) => ({ re: phraseRe(entry.text), entry }));
  const needles = alt([
    ...config.leak.map((text) => escapeRe(text) + (/\w$/.test(text) ? "(?!\\w)" : "")),
    ...Object.keys(config.urls).map((text) => urlRe(text, "").source),
    `rakazo\\.(?:${TLDS})(?![\\w-])`,
  ]);
  const wordRe = alt([...config.leakWords, ...Object.keys(config.variants)].map((word) => `\\b${escapeRe(word)}\\b`), "g");
  const brandRe = new RegExp(escapeRe(config.from), "gi");
  const inName = new RegExp(escapeRe(config.from), "i");
  // The new brand followed by a public TLD is a domain the fork may not own (`Rakazo.com` renamed
  // by the blanket rule); the URL map's targets are ours, and the placeholder `.example` is no TLD.
  const domainRe = new RegExp(`\\b${escapeRe(config.to)}\\.(?:${TLDS})\\b`, "gi");
  const ownRe = alt(Object.values(config.urls).map(escapeRe));
  // A URL target glued to the next word means a rewrite ate part of another token
  // (`dozo.exampleputerOwner`), which the old-brand needles cannot see any more.
  const gluedRe = alt(Object.values(config.urls).filter((value) => /\w$/.test(value)).map((value) => `${escapeRe(value)}\\w`));

  function scan(rel, line) {
    const found = [];
    let text = line;
    for (const { re, entry } of phrases) if (entryApplies(entry, rel)) text = blank(text, re);
    for (const { re, entry } of reviewed) if (entry.file === rel) text = blank(text, re);
    const push = (re, label) => {
      for (const m of re ? text.matchAll(re) : []) found.push({ start: m.index, text: m[0], label });
    };
    push(needles);
    push(wordRe);
    push(QUOTED_NAME, "name sent outward");
    push(gluedRe, "url target glued to a word");
    for (const literal of config.literals) {
      const at = literalApplies(literal, rel) ? text.indexOf(literal.find) : -1;
      if (at >= 0) found.push({ start: at, text: literal.find, label: "literal rule not applied" });
    }
    const own = ownRe ? blank(text, ownRe) : text;
    for (const m of own.matchAll(domainRe)) found.push({ start: m.index, text: m[0], label: "brand domain" });
    let rest = text;
    // A line without the name has nothing to mask and nothing left to find.
    if (inName.test(text)) {
      const masks = SHAPES.flatMap((shape) => shapeMatches(shape, text));
      for (const m of masks) rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
    for (const m of rest.matchAll(brandRe)) found.push({ start: m.index, text: m[0] });
    return dedupe(found);
  }

  function scanPath(rel) {
    const out = [];
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      if (inName.test(parts[i]) && !config.allowPathsRe.some((re) => re.test(prefix))) out.push(prefix);
    }
    return out;
  }

  return { scan, scanPath };
}

/** Longest first at the same start; a finding inside the span of an earlier one is the same leak. */
function dedupe(found) {
  found.sort((a, b) => a.start - b.start || b.text.length - a.text.length);
  const out = [];
  let end = -1;
  for (const f of found) {
    if (f.start < end) continue;
    out.push(f);
    end = f.start + f.text.length;
  }
  return out;
}
