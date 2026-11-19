// `make olcum`, inside the dozo-olcum image (collect.sh): runs every measuring step and writes the
// raw per-file results to /out/measures.json. Scoring is score.mjs; the report is report.mjs.
// A step that cannot run fails the whole measurement: no number is ever left out silently.
import { writeFileSync } from "node:fs";
import { audit, bundle, checks, tests } from "./dynamic.mjs";
import { isCode, isTest, listFiles } from "./run.mjs";
import { biome, deadCode, duplication, functions, shell, types } from "./static.mjs";

async function step(name, work) {
  const started = Date.now();
  const result = await work();
  console.log(`[olcum] ${name}: ${Math.round((Date.now() - started) / 1000)}s`);
  return result;
}

const files = listFiles();
const code = files.filter(isCode);
const source = code.filter((file) => !isTest(file));
const scripts = files.filter((file) => file.endsWith(".sh"));

const measures = {
  files: { code, source, shell: scripts },
  types: await step("tsc", () => types(files)),
  biome: await step("biome", biome),
  functions: await step("eslint (complexity, length)", () => functions(source)),
  duplication: await step("jscpd", () => duplication(source)),
  deadCode: await step("knip", deadCode),
  shellcheck: await step("shellcheck", () => shell(scripts)),
  checks: await step("pnpm checks", () => checks(files)),
  audit: await step("pnpm audit", audit),
  tests: await step("tests and coverage", () => tests(files)),
  bundle: await step("web build and bundle size", bundle),
};
writeFileSync("/out/measures.json", JSON.stringify(measures));
