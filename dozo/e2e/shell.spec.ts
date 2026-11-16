import { expect, test } from "@playwright/test";
import {
  notCovered,
  openSettings,
  PASSWORD,
  settingsSections,
  shellReachable,
  signUpThroughForm,
  throwawayUser,
} from "./support";

test("sign up, sign out and sign in again with the same user", async ({ page }) => {
  const user = throwawayUser();
  await signUpThroughForm(page, user);
  await expect(page.getByText("Connect a model").or(page.getByTestId("user-menu-trigger"))).toBeVisible();

  // Without a connected model the account only reaches onboarding; with one, move through Settings.
  if (await shellReachable(page)) {
    const settings = await openSettings(page);
    const sections = await settingsSections(page);
    expect(sections.length, `settings sections: ${sections.join(", ")}`).toBeGreaterThanOrEqual(3);
    for (const section of sections.slice(0, 4)) {
      await settings.getByTestId(`settings-nav-${section}`).click();
      await expect(settings).toHaveAttribute("data-settings-section", section);
    }
    await settings.getByRole("button", { name: "Close user settings" }).click();
  } else {
    notCovered("Settings sections need a connected model; the shell redirects to onboarding without one");
  }

  // No storage key was corrupted by the rebrand (an earlier bug wrote `dozo.exampleputerOwner`).
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.length, "no localStorage keys at all").toBeGreaterThan(0);
  for (const key of keys) {
    expect(key, `localStorage key "${key}"`).toMatch(/^[A-Za-z][\w.:-]*$/);
    expect(key, `localStorage key "${key}"`).not.toContain("example");
  }

  if (await page.getByTestId("user-menu-trigger").isVisible()) {
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Log out" }).click();
  } else {
    await page.getByTestId("account-menu").click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
  }
  await expect(page.getByRole("heading", { name: "Sign in to Dozo" })).toBeVisible();

  const email = page.getByLabel("Email", { exact: true });
  const choice = page.getByRole("button", { name: "Continue with email" });
  await expect(email.or(choice)).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(onboarding|app)/);
  await expect(page.getByText("Connect a model").or(page.getByTestId("user-menu-trigger"))).toBeVisible();
});
