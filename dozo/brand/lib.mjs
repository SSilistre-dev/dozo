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
    allow: {
      files: list(raw.allow?.files),
      phrases: list(raw.allow?.phrases),
      lowercase: list(raw.allow?.lowercase),
      images: list(raw.allow?.images),
    },
    literals: list(raw.literals),
    leak: list(raw.leak),
    leakWords: list(raw.leakWords),
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
    ["allow.lowercase", config.allow.lowercase],
    ["allow.images", config.allow.images],
    ["literals", config.literals],
  ]) {
    if (entries.some((entry) => !entry.reason)) fail(`every ${name} entry needs a reason`);
  }
  config.includeRe = config.include.map(globToRegExp);
  config.excludeRe = config.exclude.map((entry) => globToRegExp(entry.glob));
  config.allowFilesRe = config.allow.files.map((entry) => globToRegExp(entry.glob));
  config.allowLowercaseRe = config.allow.lowercase.map((entry) => globToRegExp(entry.glob));
  config.allowImagesRe = config.allow.images.map((entry) => globToRegExp(entry.glob));
  for (const literal of config.literals) {
    if (!literal.find || literal.replace === undefined) fail(`literal needs find and replace: ${JSON.stringify(literal)}`);
    literal.filesRe = (literal.files ?? []).map(globToRegExp);
  }
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

/** A literal applies to every file in scope, or only to the globs in its `files`. */
export const literalApplies = (literal, rel) =>
  literal.filesRe.length === 0 || literal.filesRe.some((re) => re.test(rel));

/**
 * URL keys match only when no word character follows: `rakazo.com` must not eat the start of
 * `rakazo.computerOwner`. Shared by apply and the leak gate.
 */
export const urlRe = (key, flags = "g") =>
  new RegExp(escapeRe(key) + (/\w$/.test(key) ? "(?!\\w)" : ""), flags);

/**
 * Rewrites one file's text: literals, URL map (longest key first), then the whole-word name.
 * `rel` selects the literals that are limited to some files.
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
    text = text.replace(urlRe(key), () => (n++, config.urls[key]));
    bump(`url ${key}`, n);
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

// ---------------------------------------------------------------------------------------------
// Gate-side only (check.mjs): where the old brand shows up as READABLE text that apply leaves
// alone (`rakazo`, `RAKAZO`, social handles), as opposed to identifiers that stay on purpose.
// ---------------------------------------------------------------------------------------------

// A brand word is an identifier when glued to one of these on the left (`x-rakazo`, `.rakazo`,
// `@rakazo/`, `$rakazo`, `{rakazo`, `\rakazo` Windows path, `/rakazo` path) or on the right
// (`rakazo_app`, `rakazo/x`, `rakazo=`, `rakazo.key`, `rakazo:key`, `rakazo-x`, `rakazo-${id}`).
// Standing alone (spaces, quotes, tag brackets, sentence punctuation) it is a word a person reads.
const standalone = (word) =>
  new RegExp(`(?<![\\w.:/@$#{\\\\=\\-])${word}(?![\\w/@$=]|[.:\\-][\\w/$])`, "g");
const LOWER = standalone("rakazo");
const UPPER = standalone("RAKAZO");

const WORDS_ONLY = /^(?!(?:import|export|const|let|var|return|from|type|case|function|class|interface|if|else|await|async|yield|new|throw|default|echo|ENV|RUN|COPY|ARG)\b)[A-Za-z][^=;{}<>]*$/;
const STRING_RE = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g;
const ATTR_RE = /\b(?:alt|aria-label|aria-description|aria-placeholder|title|placeholder|label|tooltip)=\{?["'`]([^"'`]*)/g;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|\{\/\*|<!--)/;
const noComment = (line) => line.replace(/\s\/\/\s.*$/, "");

// Profile links: <host><path prefix>rakazo..., any case. Prefix entries end in `/` or `@`.
const SOCIAL_RE = new RegExp(
  "(?<![\\w.-])(?:(?:www|mobile|m)\\.)?(?:" +
    [
      "x\\.com/",
      "twitter\\.com/",
      "github\\.com/",
      "facebook\\.com/",
      "fb\\.com/",
      "instagram\\.com/",
      "t\\.me/",
      "tiktok\\.com/@",
      "threads\\.net/@",
      "bsky\\.app/profile/",
      "linkedin\\.com/(?:company|in|showcase)/",
      "youtube\\.com/(?:@|c/|user/|channel/)",
      "medium\\.com/@?",
      "reddit\\.com/(?:r|user|u)/",
      "discord\\.gg/",
      "discord\\.com/invite/",
    ].join("|") +
    ")rakazo",
  "gi",
);

const firstOf = (re, text) => {
  re.lastIndex = 0;
  const m = re.exec(text);
  re.lastIndex = 0;
  return m ? m[0] : null;
};

/**
 * Ordered detectors for readable old-brand text. `gate` is the cheap "is there anything to
 * examine" test (used for the examined/flagged counts); `find(line)` returns the offending text
 * or null. `lower` patterns are skipped in files reviewed in `allow.lowercase`.
 */
export const VISIBLE_PATTERNS = [
  {
    // RAKAZO is only ever an identifier as RAKAZO_*/__RAKAZO_X__; standing alone it is text.
    name: "all-caps word",
    gate: /RAKAZO/,
    find: (line) => firstOf(UPPER, line),
  },
  {
    // x.com/rakazo, github.com/rakazo, linkedin.com/company/rakazo ...: profile links apply does not map.
    name: "social profile link",
    gate: /rakazo/i,
    find: (line) => firstOf(SOCIAL_RE, line),
  },
  {
    // "Follow @rakazo": a handle, unlike the package scope `@rakazo/core`.
    name: "@handle",
    gate: /@rakazo/,
    find: (line) => firstOf(/(?<![\w@.])@rakazo(?![\w/-])/g, line),
    lower: true,
  },
  {
    // alt="rakazo logo", aria-label="Open rakazo menu", title=, placeholder=, label=.
    name: "visible attribute",
    gate: /rakazo/,
    find: (line) => {
      for (const m of line.matchAll(ATTR_RE)) if (firstOf(LOWER, m[1])) return m[0];
      return null;
    },
    lower: true,
  },
  {
    // <p>Welcome to rakazo</p>: standalone word between tag brackets on one line.
    name: "text between tags",
    gate: /rakazo/,
    find: (line) => {
      for (const m of noComment(line).matchAll(/>([^<>{}]*)</g)) if (firstOf(LOWER, m[1])) return m[0];
      return null;
    },
    lower: true,
  },
  {
    // "Thanks for trying rakazo, the team": a string with spaces and the standalone word.
    // One word (`"rakazo"`) is the quoted-name check; `rakazo-${id}`-style names have no standalone word.
    name: "prose in string",
    gate: /rakazo/,
    find: (line) => {
      for (const m of noComment(line).matchAll(STRING_RE)) {
        const inner = m[1] ?? m[2] ?? m[3];
        if (/\s/.test(inner) && firstOf(LOWER, inner)) return m[0];
      }
      return null;
    },
    lower: true,
  },
  {
    // A line of plain words (JSX text on its own line, a template-literal prompt): no code punctuation.
    name: "prose line",
    gate: /rakazo/,
    find: (line) => {
      if (COMMENT_LINE.test(line) || /^\s*#/.test(line)) return null;
      const text = noComment(line).trim();
      return /\s/.test(text) && WORDS_ONLY.test(text) && !/\w[(]/.test(text) ? firstOf(LOWER, text) : null;
    },
    lower: true,
  },
];

/** `[{ pattern, text }]` for one line; `lowercaseOk` drops the lowercase-only patterns (reviewed files). */
export function visibleLeaks(line, { lowercaseOk = false } = {}) {
  const out = [];
  for (const p of VISIBLE_PATTERNS) {
    if (p.lower && lowercaseOk) continue;
    const text = p.gate.test(line) ? p.find(line) : null;
    if (text) out.push({ pattern: p.name, text });
  }
  return out;
}
