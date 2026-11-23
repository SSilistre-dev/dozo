// The web startup budget on a branded build: upstream's own check (scripts/checks/bundle-size.mjs
// and its budgets file, both from the tree given as the root) for the web app only, since the fork's
// builds have no desktop main bundle. Always prints one `web-startup: <measured> of <limit>` line.
// Usage: node web-budget.mjs <root holding scripts/checks and apps/web/dist>. Exit 0 within the
// budget, 2 over it or when it cannot be measured, 64 usage.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "web-startup";
const root = process.argv[2];
if (!root) {
  console.error("usage: node web-budget.mjs <root>");
  process.exit(64);
}
const { checkBundleSizes } = await import(pathToFileURL(path.join(root, "scripts/checks/bundle-size.mjs")).href);
const budgets = JSON.parse(readFileSync(path.join(root, "scripts/checks/bundle-size.budgets.json"), "utf8"));
const { passed, failures } = checkBundleSizes(root, budgets);
// The one failure that belongs to the other bundle: the desktop app is not built here.
const mine = failures.filter((f) => !f.startsWith("Cannot measure desktop-main:") && !f.includes(": desktop-main,"));
const line = passed.find((l) => l.startsWith(`${NAME}: `));
if (line && mine.length === 0) {
  console.log(line);
  process.exit(0);
}
for (const failure of mine) {
  const m = failure.match(/Measured ([\d.,]+ kB), limit ([\d.,]+ kB), over by ([\d.,]+ kB)/);
  if (m) console.log(`${NAME}: ${m[1]} of ${m[2]}, over by ${m[3]}`);
  console.error(failure);
}
if (mine.length === 0) console.error(`${NAME}: no result from scripts/checks/bundle-size.mjs`);
process.exit(2);
