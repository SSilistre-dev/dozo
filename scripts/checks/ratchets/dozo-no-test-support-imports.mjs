// Product code never imports a test-support module. The unit gate does not measure coverage of
// `*.test-support.*` files, so code only product code calls must not be able to live in one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const message =
  "Product code must not import a *.test-support.* module (directly or through a package export that points at one): coverage is not measured there. Move the code product code needs into a regular module, and keep test-support files for tests.";

export const include = ["{apps,packages,infra}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*.test-support.*",
  "**/{test,tests,__tests__,e2e,testing}/**",
  "**/vitest.*",
  "**/playwright.*",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_SUPPORT = /\.test-support(?:\.[cm]?[jt]sx?)?$/;

/** Package subpaths (`@scope/pkg/sub`) whose export points at a test-support file. */
export function supportExports(dir = root) {
  const specifiers = new Set();
  for (const group of ["apps", "packages"]) {
    if (!existsSync(path.join(dir, group))) continue;
    for (const name of readdirSync(path.join(dir, group))) {
      const file = path.join(dir, group, name, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (!manifest.name || !manifest.exports || typeof manifest.exports !== "object") continue;
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        if (subpath.startsWith(".") && TEST_SUPPORT.test(firstTarget(target) ?? ""))
          specifiers.add(path.posix.join(manifest.name, subpath));
      }
    }
  }
  return specifiers;
}

function firstTarget(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object")
    for (const value of Object.values(target)) {
      const found = firstTarget(value);
      if (found) return found;
    }
  return undefined;
}

const aliases = supportExports();

// `import … from "x"`, `export … from "x"`, `import "x"`, `import("x")`, `require("x")`.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;

/** Comment text before a match on its line: prose that names a file is not an import. */
const IN_COMMENT = /^\s*(?:\/\/|\/\*|\*)|\s\/\/\s/;

/** One hit per import of a test-support module, by file name or by package export. */
export function count(text, _file, known = aliases) {
  const hits = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const bare = match[2].replace(/\?.*$/, "");
    if (!TEST_SUPPORT.test(bare) && !known.has(bare)) continue;
    const start = text.lastIndexOf("\n", match.index) + 1;
    if (IN_COMMENT.test(text.slice(start, match.index))) continue;
    const line = text.slice(0, match.index).split("\n").length;
    hits.push({ line, text: text.split("\n")[line - 1].trim() });
  }
  return hits;
}
