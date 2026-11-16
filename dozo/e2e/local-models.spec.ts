import { expect, readWorld, test } from "./fixtures";
import { openBot, openUserSettings } from "./ui";

const PANEL = "Run on this computer";

// Both the onboarding model step and account Models settings, now reachable with the offline model.
test("no local-model panel while the published list is empty, upstream form still works", async ({ page, theme }) => {
  test.skip(theme !== "light", "the panel does not depend on the theme");
  await page.goto("/onboarding/model", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await expect(page.getByRole("option").first(), "provider list shows options").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(PANEL, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: PANEL })).toHaveCount(0);

  await openBot(page, readWorld().chiefId, "Chief");
  const settings = await openUserSettings(page, "models");
  await expect(settings.getByText(PANEL, { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: PANEL })).toHaveCount(0);
});

test("the local-model panel appears once a published list exists", async ({ page }) => {
  test.fixme(true, "published model list is empty until tool-calling checks are recorded");
  await page.goto("/onboarding/model");
  await expect(page.getByText(PANEL, { exact: true })).toBeVisible();
  const settings = await openUserSettings(page, "models");
  await expect(settings.getByText(PANEL, { exact: true })).toBeVisible();
});
