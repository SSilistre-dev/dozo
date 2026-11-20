import type { Page } from "@playwright/test";
import { expect, readWorld, test } from "./fixtures";
import { openBot, openUserSettings } from "./ui";

const PANEL = "Run on this computer";
// The stack runs on the owner's own computer, so the server looks for model servers there. None
// runs on the default addresses in this suite, unless the person running it has one open.
const FOUND = (page: Page) =>
  page
    .getByText("No model server is running", { exact: true })
    .or(page.getByRole("button", { name: /^Connect / }).first());

// Both the onboarding model step and account Models settings, now reachable with the offline model.
test("the local-model panel looks on this computer, upstream form still works", async ({
  page,
  theme,
}) => {
  test.skip(theme !== "light", "the panel does not depend on the theme");
  await page.goto("/onboarding/model", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await expect(page.getByRole("option").first(), "provider list shows options").toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: PANEL }).click();
  await expect(FOUND(page)).toBeVisible();

  await openBot(page, readWorld().chiefId, "Chief");
  const settings = await openUserSettings(page, "models");
  await settings.getByRole("button", { name: PANEL }).click();
  await expect(FOUND(page)).toBeVisible();
});
