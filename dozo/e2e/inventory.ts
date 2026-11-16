import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the web app offers, read from its own source so the crawl cannot silently fall behind an
 * upstream that adds a route, a settings section or an overlay: `route:<path>`, `settings:<id>`,
 * `overlay:<name>`, `onboarding:<step>`. `surfaces.ts` must cover or explicitly skip each one.
 */

const HERE = __dirname;

export function webSourceDir() {
  const candidates = [
    process.env.DOZO_E2E_SRC,
    "/webapp-src", // run.sh mounts the staged tree's apps/web/src here
    join(HERE, "../.stage/src/apps/web/src"),
    join(HERE, "../../apps/web/src"),
  ].filter((dir): dir is string => Boolean(dir));
  const found = candidates.find((dir) => existsSync(join(dir, "App.tsx")));
  if (!found) throw new Error(`web app source not found; looked in ${candidates.join(", ")}`);
  return found;
}

function read(root: string, relative: string) {
  const file = join(root, relative);
  if (!existsSync(file)) {
    throw new Error(`inventory: ${relative} is gone from the web app source; update e2e/inventory.ts`);
  }
  return readFileSync(file, "utf8");
}

export type Inventory = { keys: string[]; unavailable: Record<string, string> };

export function readInventory(root = webSourceDir()): Inventory {
  const keys = new Set<string>();
  const unavailable: Record<string, string> = {};

  // Routes: <Route path="…"> literals, path={CONST} and the ["/a", "/b"].map(path => <Route …>) lists.
  const app = read(root, "App.tsx");
  const constants: Record<string, string> = {};
  for (const file of ["lib/sign-in-next.ts", "lib/sso-flow.ts"]) {
    for (const match of read(root, file).matchAll(/export const ([A-Z_]+) = "([^"]+)"/g)) {
      constants[match[1] as string] = match[2] as string;
    }
  }
  const resolve = (name: string) => {
    const value = constants[name];
    if (!value) throw new Error(`inventory: route constant ${name} is not exported as a string; update e2e/inventory.ts`);
    return value;
  };
  for (const match of app.matchAll(/\bpath=(?:"([^"]+)"|\{([A-Z][A-Z0-9_]*)\})/g)) {
    keys.add(`route:${match[1] ?? resolve(match[2] as string)}`);
  }
  for (const list of app.matchAll(/\[((?:\s*"\/[^"]*",?)+)\s*\]\s*\.map/g)) {
    for (const path of (list[1] as string).matchAll(/"(\/[^"]*)"/g)) keys.add(`route:${path[1]}`);
  }
  for (const match of app.matchAll(/pathname === (?:"([^"]+)"|([A-Z_]+))/g)) {
    keys.add(`route:${match[1] ?? resolve(match[2] as string)}`);
  }
  if (![...keys].some((key) => key === "route:/app" || key === "route:/sign-in")) {
    throw new Error("inventory: found no /app or /sign-in route in App.tsx; the router changed shape, update e2e/inventory.ts");
  }

  // Settings sections and the flag each optional one waits on.
  const overlay = read(root, "pages/shell-overlay.ts");
  const sections = /const SETTINGS_SECTIONS = \[([^\]]+)\]/.exec(overlay);
  if (!sections) throw new Error("inventory: SETTINGS_SECTIONS not found in shell-overlay.ts; update e2e/inventory.ts");
  for (const id of (sections[1] as string).matchAll(/"(\w+)"/g)) keys.add(`settings:${id[1]}`);
  const nav = read(root, "pages/settings-nav.ts");
  for (const match of nav.matchAll(/available\.(\w+)\s*\?\s*\[\s*\{\s*id:\s*"(\w+)"/g)) {
    unavailable[`settings:${match[2]}`] = `shown only when the deployment reports "${match[1]}"`;
  }

  // Overlays opened by a URL parameter other than settings.
  const params = /const OVERLAY_KEYS = \[([^\]]+)\]/.exec(overlay);
  if (!params) throw new Error("inventory: OVERLAY_KEYS not found in shell-overlay.ts; update e2e/inventory.ts");
  for (const id of (params[1] as string).matchAll(/"(\w+)"/g)) {
    if (id[1] !== "settings" && id[1] !== "space" && id[1] !== "messaging") keys.add(`overlay:${id[1]}`);
  }

  // Onboarding steps.
  const onboarding = read(root, "pages/Onboarding.tsx");
  for (const match of onboarding.matchAll(/step === "(\w+)"/g)) {
    if (match[1] !== "loading") keys.add(`onboarding:${match[1]}`);
  }
  return { keys: [...keys].sort(), unavailable };
}
