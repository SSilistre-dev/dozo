import { readWorld } from "../fixtures";
import { openBot, openBotPanel } from "../ui";
import { adminBrowser } from "./accounts";
import { expect, test } from "./flow";

/**
 * The local computer provider (docker) starts the team computer from the bot panel; the admin's
 * Computers list stops it, and the panel shows it asleep again. It also ends the run with no
 * computer left running.
 */
test("computer: start from the bot panel, stop from the admin list", async ({
  page,
  browser,
  guard,
}) => {
  test.setTimeout(300_000);
  guard.allow(
    /net::ERR_(INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|CONNECTION_REFUSED)/,
    "streams cut on purpose: the stopped computer's screen, and the live stream of each admin reload",
  );
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  await openBotPanel(page);
  // Waking opens the computer's own window once its screen is up.
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 180_000,
  });
  await page.keyboard.press("Escape");
  const admin = (await adminBrowser(browser)).page;
  guard.follow(admin);
  await admin.goto("/admin");
  const computers = admin.getByTestId("admin-computers");
  const mine = computers.getByRole("listitem").filter({ hasText: world.user.email });
  await expect(mine).toBeVisible();
  await mine.getByRole("button", { name: "Stop" }).click();
  // A confirmation may follow.
  const confirm = admin.getByRole("alertdialog");
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Stop" }).click();
  // Stopping takes the provider a while; the list is read again until the row is gone.
  await expect(async () => {
    await admin.reload();
    await expect(admin.getByTestId("admin-status")).toBeVisible();
    await expect(mine).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 120_000 });
  await page.reload();
  await openBotPanel(page);
  await expect(page.getByTestId("computer-preview-open").filter({ hasText: "Wake" })).toBeVisible({
    timeout: 60_000,
  });
});
