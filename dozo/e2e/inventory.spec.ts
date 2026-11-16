import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { readInventory } from "./inventory";
import { SKIPS, SURFACES } from "./surfaces";

test("every route, settings section and overlay of the web app is crawled or skipped with a reason", () => {
  const inventory = readInventory();
  const covered = new Set(SURFACES.flatMap((surface) => surface.covers ?? []));
  const skipped = Object.keys(SKIPS);
  const missing = inventory.keys.filter((key) => !covered.has(key) && !skipped.includes(key));
  expect(
    missing,
    `The web app offers these and the crawl neither visits nor skips them:\n  ${missing.join("\n  ")}\n` +
      "Add a surface that lists the key in `covers` (e2e/surfaces.ts), or add it to SKIPS with the reason.",
  ).toEqual([]);
  const stale = [...covered, ...skipped].filter((key) => !inventory.keys.includes(key));
  expect(
    stale,
    `surfaces.ts names keys the web app no longer has:\n  ${stale.join("\n  ")}\nRemove them (or fix the spelling).`,
  ).toEqual([]);
  const both = skipped.filter((key) => covered.has(key));
  expect(
    both,
    `these are both visited and in SKIPS; drop the skip:\n  ${both.join("\n  ")}`,
  ).toEqual([]);
  for (const [key, reason] of Object.entries(SKIPS))
    expect(reason.length, `SKIPS["${key}"] needs a reason`).toBeGreaterThan(10);
  expect(inventory.keys.length, "inventory found suspiciously little").toBeGreaterThan(20);
});

// readInventory reads the app's source with regular expressions. These run it on a tiny source tree
// of the same shape, so a regex that stops matching fails here with a name, not as "found little".
const SOURCE: Record<string, string> = {
  "App.tsx": `
    <Route path="/sign-in" element={<A />} />
    <Route path="/app/:botId" element={<B />} />
    <Route path={SIGN_UP_PATH} element={<C />} />
    {["/a", "/b/c"].map((path) => (<Route path={path} element={<D />} />))}
    {window.location.pathname === "/integrations/callback" ? 1 : 2}
    {pathname === SSO_CALLBACK_PATH ? 1 : 2}
    <Route path="*" element={<NotFound />} />`,
  "lib/sign-in-next.ts": 'export const SIGN_UP_PATH = "/sign-up";',
  "lib/sso-flow.ts": 'export const SSO_CALLBACK_PATH = "/sso/callback";',
  "pages/shell-overlay.ts": `
    const SETTINGS_SECTIONS = ["profile", "billing", "wallet"] as const;
    const OVERLAY_KEYS = ["settings", "space", "messaging", "skills", "mcp"] as const;`,
  "pages/settings-nav.ts": 'available.billing ? [{ id: "billing", label: "Billing" }] : []',
  "pages/Onboarding.tsx": 'step === "loading"; step === "survey"; step === "model";',
};

function withSource<T>(files: Record<string, string>, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "dozo-inventory-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("readInventory finds every route form, section, overlay and step in a fixture tree", () => {
  const inventory = withSource(SOURCE, (root) => readInventory(root));
  expect(inventory.keys).toEqual(
    [
      "route:/sign-in",
      "route:/app/:botId",
      "route:/sign-up", // path={CONSTANT}, resolved from lib/
      "route:/a", // the ["/a", "/b/c"].map list
      "route:/b/c",
      "route:/integrations/callback", // pathname === "literal"
      "route:/sso/callback", // pathname === CONSTANT
      "route:*",
      "settings:profile",
      "settings:billing",
      "settings:wallet",
      "overlay:skills", // settings, space and messaging are not overlays of their own
      "overlay:mcp",
      "onboarding:survey", // "loading" is not a step
      "onboarding:model",
    ].sort(),
  );
  expect(inventory.unavailable).toEqual({
    "settings:billing": 'shown only when the deployment reports "billing"',
  });
});

test("readInventory refuses a source tree whose shape it no longer understands", () => {
  const without = (name: string, text?: string) => {
    const files = { ...SOURCE };
    if (text === undefined) delete files[name];
    else files[name] = text;
    return files;
  };
  const cases: [string, Record<string, string>, RegExp][] = [
    ["a missing file", without("pages/settings-nav.ts"), /settings-nav\.ts is gone/],
    [
      "a route constant that is not a string export",
      without("lib/sign-in-next.ts", "export const OTHER = 1;"),
      /SIGN_UP_PATH is not exported/,
    ],
    [
      "no /app or /sign-in route",
      without("App.tsx", '<Route path="/x" />'),
      /no \/app or \/sign-in/,
    ],
    [
      "no settings list",
      without("pages/shell-overlay.ts", "const OVERLAY_KEYS = [];"),
      /SETTINGS_SECTIONS not found/,
    ],
  ];
  for (const [name, files, message] of cases) {
    expect(() => withSource(files, (root) => readInventory(root)), name).toThrow(message);
  }
});
