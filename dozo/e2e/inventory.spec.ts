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
