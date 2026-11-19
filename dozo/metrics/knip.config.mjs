// knip's own defaults plus the entry points it cannot see, for `make olcum`'s deadCode measure.
// Nothing is ignored or left out: every file is still scanned, and only files something really
// starts are added as entries.
import { readFileSync } from "node:fs";

// knip's default entry for every workspace (ConfigurationChief.js); an `entry` replaces it, so it
// is repeated here.
const EXTENSIONS = "js,mjs,cjs,jsx,ts,tsx,mts,cts";
const DEFAULT_ENTRY = [
  `{index,cli,main}.{${EXTENSIONS}}!`,
  `src/{index,cli,main}.{${EXTENSIONS}}!`,
];

// dozo/ files started from a shell script, a Makefile target or an HTML page.
const FORK_SCRIPTS = [
  "dozo/brand/apply.mjs", // dozo/docker/build.sh, gate.sh
  "dozo/brand/check.mjs", // dozo/docker/build.sh, gate.sh
  "dozo/brand/assets/render.mjs", // dozo/brand/assets/build.sh
  "dozo/metrics/collect.mjs", // dozo/metrics/collect.sh
  "dozo/metrics/report.mjs", // dozo/metrics/olcum.sh
  "packages/testkit/src/cli/dozo-token-kiyas.ts", // dozo/metrics/token-kiyas.sh
  "dozo/e2e/playwright.config.ts", // dozo/e2e/run.sh (npx playwright test)
  "dozo/e2e/auth.setup.ts", // the setup project of playwright.config.ts
  "dozo/e2e/coverage-reporter.ts", // a reporter of playwright.config.ts
  "dozo/landing/landing.js", // <script> of dozo/landing/*.html
  "dozo/desktop/ui/local.js", // <script> of dozo/desktop/ui/index.html
];

// The workspaces of pnpm-workspace.yaml that hold dozo-* files.
const WORKSPACES = [
  "apps/api",
  "apps/mobile",
  "apps/web",
  "infra/sandboxes/supervisor",
  "packages/adapters",
  "packages/auth",
  "packages/contracts",
  "packages/core",
  "packages/db",
  "packages/ui-web",
];

// A file an anchored rule of dozo/brand/brand.json requires is imported by that rule's replace
// text, which only the branded staged tree carries: an entry point of the unbranded tree.
function brandRequires() {
  const brand = JSON.parse(readFileSync(new URL("../brand/brand.json", import.meta.url), "utf8"));
  return brand.anchored.flatMap((rule) => rule.requires ?? []);
}

export default function config() {
  const required = brandRequires().filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const workspaces = { ".": { entry: [...DEFAULT_ENTRY, ...FORK_SCRIPTS] } };
  for (const workspace of WORKSPACES) {
    const own = required
      .filter((file) => file.startsWith(`${workspace}/`))
      .map((file) => file.slice(workspace.length + 1));
    if (own.length) workspaces[workspace] = { entry: [...DEFAULT_ENTRY, ...own] };
  }
  const placed = Object.keys(workspaces).flatMap((ws) => (ws === "." ? [] : [ws]));
  const stray = required.filter((file) => !placed.some((ws) => file.startsWith(`${ws}/`)));
  if (stray.length) throw new Error(`knip.config.mjs: no workspace for ${stray.join(", ")}`);
  return { workspaces };
}
