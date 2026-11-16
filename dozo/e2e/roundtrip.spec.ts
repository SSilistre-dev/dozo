import { expect, test } from "@playwright/test";
import { readWorld } from "./fixtures";
import { expectNotRateLimited, openEmailForm } from "./support";

test.use({ storageState: { cookies: [], origins: [] } });

// Sign-in and sign-out in one test, with the account the setup project created.
test("sign in, sign out", async ({ page }) => {
  const { user } = readWorld();
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Dozo" })).toBeVisible();
  await openEmailForm(page);
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  const signIn = page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await signIn;
  expectNotRateLimited(response.status(), response.headers(), "sign-in");
  expect(response.ok(), `sign-in answered ${response.status()}`).toBe(true);
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();

  // No storage key was corrupted by the rebrand (an earlier bug wrote `dozo.exampleputerOwner`).
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.length, "no localStorage keys at all").toBeGreaterThan(0);
  for (const key of keys) {
    expect(key, `localStorage key "${key}"`).toMatch(/^[A-Za-z][\w.:-]*$/);
    expect(key, `localStorage key "${key}"`).not.toContain("example");
  }

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Dozo" })).toBeVisible();
});
