import { mkdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, readWorld } from "../fixtures";
import { outDir } from "../scan";
import { openBot } from "../ui";
import { expect, test } from "./flow";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/chat-export--${name}.png` });
}

/** Right-clicks the open chat in the roster and opens the Export submenu. */
async function openExport(page: Page) {
  await page.locator('[data-roster-bot-id][aria-current="page"]').click({ button: "right" });
  const menu = page.locator('[data-slot="context-menu-content"]').first();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Export" }).hover();
  const sub = page.locator('[data-slot="context-menu-content"]').nth(1);
  await expect(sub.getByRole("menuitem", { name: "Download Markdown" })).toBeVisible();
  return sub;
}

/**
 * A chat's roster menu has one Export submenu: pick a range, then copy or download. The file is
 * the server's Markdown of the chat as its transcript shows it: the title, who said what and when.
 */
test("chat export: download and copy a chat as Markdown from the roster menu", async ({
  page,
}) => {
  const world = readWorld();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openBot(page, world.chiefId, "Chief");
  await expect(page.getByText("Hello from the offline Dozo test model.").first()).toBeVisible();

  const sub = await openExport(page);
  await expect(sub.getByRole("menuitemradio", { name: "Whole chat" })).toBeChecked();
  await shot(page, "1-light");
  const download = page.waitForEvent("download");
  await sub.getByRole("menuitem", { name: "Download Markdown" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Chief-\d{4}-\d{2}-\d{2}\.md$/);
  const saved = `${outDir()}/shots/chat-export--download.md`;
  await file.saveAs(saved);
  const markdown = readFileSync(saved, "utf8");
  expect(markdown.startsWith("# Chief\n\n")).toBe(true);
  expect(markdown).toMatch(/\*\*Chief\*\* · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  expect(markdown).toContain("Hello from the offline Dozo test model.");

  const again = await openExport(page);
  await again.getByRole("menuitemradio", { name: "Today" }).click();
  await again.getByRole("menuitem", { name: "Copy as Markdown" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Hello from the offline Dozo test model.");

  await page.evaluate((key) => localStorage.setItem(key, "dark"), APPEARANCE_KEY);
  await openBot(page, world.chiefId, "Chief");
  await openExport(page);
  await shot(page, "2-dark");
  await page.keyboard.press("Escape");
  await page.evaluate((key) => localStorage.removeItem(key), APPEARANCE_KEY);
});
