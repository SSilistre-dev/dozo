// Static measurements, each by one pinned tool at its own defaults. Every step returns per-file
// counts keyed by repository-relative path, so score.mjs can split fork code from the rest.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { bump, eachLimited, must, SRC, STAGE, TOOLS } from "./run.mjs";

const TSC_PROJECT = /tsc --noEmit -p (\S+)/g;
const TSC_ERROR = /^(.+?)\((\d+),(\d+)\): error TS\d+/;

/** The tsconfig files the workspace packages' `check` scripts type-check (astro and expo excluded). */
function tscProjects(files) {
  return files
    .filter((file) => /^(apps|packages|infra)\/(.+\/)?package\.json$/.test(file))
    .flatMap((file) => {
      const check = JSON.parse(readFileSync(path.join(STAGE, file), "utf8")).scripts?.check ?? "";
      return [...check.matchAll(TSC_PROJECT)].map((m) => path.join(path.dirname(file), m[1]));
    });
}

/** tsc on the branded tree (fork code reads fields only branding adds): errors per file. */
export async function types(files) {
  const tsc = path.join(STAGE, "node_modules/.bin/tsc");
  const checked = new Set();
  const errors = {};
  // One project at a time: tsc parallelises inside, and three at once outgrow the memory cap.
  await eachLimited(tscProjects(files), 1, async (project) => {
    const cwd = path.join(STAGE, path.dirname(project));
    const p = path.basename(project);
    const args = ["--noEmit", "-p", p, "--pretty", "false", "--listFiles"];
    const { stdout } = await must(tsc, args, { cwd }, [0, 1, 2]);
    for (const line of stdout.split("\n")) {
      const m = line.match(TSC_ERROR);
      if (m) bump(errors, path.relative(STAGE, path.resolve(cwd, m[1])));
      else if (line.startsWith(`${STAGE}/`) && !line.includes("/node_modules/"))
        checked.add(path.relative(STAGE, line));
    }
  });
  return { checked: [...checked].sort(), errors };
}

/** Biome with the repository's own biome.jsonc: lint findings (error and warning) and format ones. */
export async function biome() {
  const bin = path.join(SRC, "node_modules/.bin/biome");
  const args = ["check", "--vcs-enabled=false", "--reporter=json", "--max-diagnostics=none", "."];
  const { stdout } = await must(bin, args, {}, [0, 1]);
  const lint = {};
  const format = {};
  for (const d of JSON.parse(stdout).diagnostics) {
    const file = d.location?.path;
    if (!file) continue;
    if (d.category === "format" || d.category.startsWith("assist/")) bump(format, file);
    else if (d.severity === "error" || d.severity === "warning") bump(lint, file);
  }
  return { lint, format };
}

/**
 * ESLint, used only to measure: with a limit of 0, max-lines reports every file's length,
 * max-lines-per-function every function's and sonarjs/cognitive-complexity every function above 0
 * with its complexity.
 */
export async function functions(files) {
  const require = createRequire(path.join(TOOLS, "x.js"));
  const { ESLint } = await import(require.resolve("eslint"));
  const sonarjs = (await import(require.resolve("eslint-plugin-sonarjs"))).default;
  const { parser } = (await import(require.resolve("typescript-eslint"))).default;
  const eslint = new ESLint({
    cwd: SRC,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], // a bare "**/*" selects no TypeScript file
        languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
        plugins: { sonarjs },
        rules: {
          "max-lines": ["error", { max: 0 }],
          "max-lines-per-function": ["error", { max: 0 }],
          "sonarjs/cognitive-complexity": ["error", 0],
        },
      },
    ],
  });
  const result = {};
  for (const r of await eslint.lintFiles(files)) {
    const entry = { lines: 0, lengths: [], complexities: [], parseError: false };
    for (const m of r.messages) {
      const n = Number(
        m.message
          .match(/\((\d+)\)|from (\d+) to/)
          ?.slice(1)
          .find(Boolean),
      );
      if (m.fatal) entry.parseError = true;
      else if (m.ruleId === "max-lines") entry.lines = n;
      else if (m.ruleId === "max-lines-per-function") entry.lengths.push(n);
      else if (m.ruleId === "sonarjs/cognitive-complexity") entry.complexities.push(n);
    }
    result[path.relative(SRC, r.filePath)] = entry;
  }
  return result;
}

/** Duplicated lines per file (the union of every clone range in it), jscpd at its defaults. */
export async function duplication(files) {
  const bin = path.join(TOOLS, ".bin/jscpd");
  await must(bin, [
    "--min-tokens",
    "50",
    "--min-lines",
    "5",
    "-r",
    "json",
    "-o",
    "/tmp/jscpd",
    ...files,
  ]);
  const report = JSON.parse(readFileSync("/tmp/jscpd/jscpd-report.json", "utf8"));
  const lines = {};
  for (const clone of report.duplicates) {
    for (const side of [clone.firstFile, clone.secondFile]) {
      lines[side.name] ??= new Set();
      for (let n = side.start; n <= side.end; n++) lines[side.name].add(n);
    }
  }
  return Object.fromEntries(Object.entries(lines).map(([file, set]) => [file, set.size]));
}

const DEAD = ["files", "exports", "types", "enumMembers", "namespaceMembers", "classMembers"];

/** knip's unused files, exports, types and members per file. */
export async function deadCode() {
  const { stdout } = await must(path.join(TOOLS, ".bin/knip"), [
    "--reporter",
    "json",
    "--no-exit-code",
  ]);
  const json = stdout.split("\n").find((line) => line.startsWith("{"));
  const found = {};
  for (const issue of JSON.parse(json).issues) {
    const n = DEAD.reduce(
      (sum, key) => sum + (Array.isArray(issue[key]) ? issue[key].length : 0),
      0,
    );
    if (n) bump(found, issue.file, n);
  }
  return found;
}

/** shellcheck at its default severity (style and up): findings per script. */
export async function shell(files) {
  if (!files.length) return {};
  const { stdout } = await must("shellcheck", ["-f", "json1", ...files], {}, [0, 1]);
  const found = {};
  for (const c of JSON.parse(stdout).comments) bump(found, c.file);
  return found;
}
