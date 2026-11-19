import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { readWorld } from "../fixtures";
import { outDir } from "../scan";
import { openBot, openBotPanel } from "../ui";
import { expect, test } from "./flow";

// Nothing answers there: the scenario needs no network. Cookies, sign-out and the domain edges
// are checked against a real browser by site-sessions-image.sh.
const SITE = "localhost:9";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/site-sessions--${name}.png` });
}

/**
 * The computer's header opens the sites the bot's browser holds cookies for. Signing in to one
 * from there takes control and opens it on the bot's screen in one click; the warning is there
 * before it, and handing back control returns the screen.
 */
test("site sessions: sign in from the computer's header with control", async ({ page, guard }) => {
  test.setTimeout(360_000);
  guard.allow(
    /^failed: net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING) [A-Z]+ [^ ]+\/(rpc|api)\//,
    "FINDING: while a computer starts or stops, the stack's own address refuses connections for a moment (no container restarts; docker sets up the computer's network); the app retries",
  );
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  await openBotPanel(page);
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 180_000,
  });
  const sites = page.getByTestId("computer-site-sessions");
  await expect(sites).toBeVisible();
  // The header as it was before: the same screen without the one new button.
  await sites.evaluate((node) => {
    (node as HTMLElement).style.display = "none";
  });
  await shot(page, "1-header-before");
  await sites.evaluate((node) => {
    (node as HTMLElement).style.display = "";
  });
  await shot(page, "2-header-after");

  await sites.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Sites with cookies")).toBeVisible();
  await expect(dialog.getByText("No sites yet").or(dialog.getByRole("list"))).toBeVisible();
  await expect(dialog.getByText("a page it reads can steer it")).toBeVisible();
  await shot(page, "3-dialog");
  await dialog.getByLabel("Site to sign in to").fill(SITE);
  // One click: the dialog closes and this person has the screen, the site opening on it. The
  // stack's own address may refuse a request for a moment after the computer starts (allowed
  // above); the dialog then says so and the person clicks again.
  await expect(async () => {
    if (await dialog.isVisible())
      await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Hand back control" })).toBeVisible({
      timeout: 20_000,
    });
  }).toPass({ timeout: 90_000 });
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(8_000);
  await shot(page, "4-in-control");
  await page.getByRole("button", { name: "Hand back control" }).click();
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 30_000,
  });

  await sites.click();
  await expect(dialog.getByText("No sites yet").or(dialog.getByRole("list"))).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "5-after");
});
