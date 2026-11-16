import { expect, test } from "@playwright/test";
import { notCovered, openSettings, shellReachable, signUpThroughForm } from "./support";

const PANEL = "Run on this computer";

test("no local-model panel while the published list is empty, upstream form still works", async ({ page }) => {
  await signUpThroughForm(page);

  // Onboarding model step (reachable without a model).
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await expect(page.getByRole("option").first(), "provider list shows options").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(PANEL, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: PANEL })).toHaveCount(0);

  // Account Models settings (inside the app shell, which needs a connected model).
  if (!(await shellReachable(page))) {
    notCovered("account Models settings need a connected model; only the onboarding model step was checked");
    return;
  }
  const settings = await openSettings(page);
  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByText(PANEL, { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: PANEL })).toHaveCount(0);
});

test("the local-model panel appears once a published list exists", async ({ page }) => {
  test.fixme(true, "published model list is empty until tool-calling checks are recorded");
  await signUpThroughForm(page);
  await page.goto("/onboarding");
  await expect(page.getByText(PANEL, { exact: true })).toBeVisible();
  const settings = await openSettings(page);
  await settings.getByTestId("settings-nav-models").click();
  await expect(settings.getByText(PANEL, { exact: true })).toBeVisible();
});
