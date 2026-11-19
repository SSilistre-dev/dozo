import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { readWorld } from "../fixtures";
import { outDir } from "../scan";
import { openBot, openBotPanel } from "../ui";
import { expect, test } from "./flow";

const SITE = "wikipedia.org";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/site-sessions--${name}.png` });
}

/**
 * The computer's header lists the sites the bot's browser is signed in to. Signing in to one from
 * there takes control and opens it on the bot's screen in one click; handing back control leaves
 * the site in the list, and signing out removes it. The bot's computer needs the internet: the
 * site sets its own cookies.
 */
test("site sessions: sign in from the computer's header, then sign out", async ({
  page,
  guard,
}) => {
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
  await expect(dialog.getByText("Signed-in sites")).toBeVisible();
  await expect(dialog.getByText("No sites yet").or(dialog.getByRole("list"))).toBeVisible();
  await shot(page, "3-dialog");
  await dialog.getByLabel("Site to sign in to").fill(SITE);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  // One click: the dialog closes and this person has the screen, the site opening on it.
  await expect(page.getByRole("button", { name: "Hand back control" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(8_000);
  await shot(page, "4-in-control");
  await page.getByRole("button", { name: "Hand back control" }).click();
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 30_000,
  });

  await sites.click();
  const row = dialog.getByRole("listitem").filter({ hasText: SITE });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await shot(page, "5-listed");
  await row.getByRole("button", { name: `Sign out of ${SITE}` }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(`Sign out of ${SITE}?`);
  await shot(page, "6-confirm");
  await confirm.getByRole("button", { name: "Sign out" }).click();
  await expect(confirm).toBeHidden({ timeout: 60_000 });
  await expect(row).toHaveCount(0);
  await shot(page, "7-signed-out");
});
