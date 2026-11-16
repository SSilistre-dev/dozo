import { expect, test } from "@playwright/test";
import { expectBranded, notCovered, openSettings, setTheme, settingsSections, shellReachable, signUpThroughForm } from "./support";

const THEMES = ["dark", "light"] as const;

test("signed-out screens carry the Dozo brand in both themes", async ({ page }) => {
  const screens = [
    ["sign-in", "/sign-in"],
    ["sign-up", "/sign-up"],
    ["forgot-password", "/forgot-password"],
    ["not-found", "/this-route-does-not-exist"],
  ] as const;
  for (const [name, path] of screens) {
    await page.goto(path);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
      await expectBranded(page, `${name} (${theme})`);
    }
  }
});

test("signed-in screens carry the Dozo brand in both themes", async ({ page }) => {
  await signUpThroughForm(page);
  // Whatever step onboarding stops at without a model is a screen to check too.
  await expect(page.locator("main, #root").first()).toBeVisible();
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await expectBranded(page, `${new URL(page.url()).pathname} (${theme})`);
  }
  // The account menu on the onboarding step.
  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await expectBranded(page, "onboarding account menu");
  await page.keyboard.press("Escape");
  if (await shellReachable(page)) {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await expectBranded(page, `home (${theme})`);
    }
    await openSettings(page);
    for (const section of await settingsSections(page)) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", section);
      await expectBranded(page, `settings/${section}`);
    }
  } else {
    notCovered("home and settings need a connected model; onboarding model step was checked instead");
  }
});

test("favicon and web manifest are served and branded", async ({ page, request }) => {
  await page.goto("/sign-in");
  const icon = await page.locator('link[rel~="icon"]').first().getAttribute("href");
  expect(icon, "no favicon link in the page head").toBeTruthy();
  const iconResponse = await request.get(new URL(icon as string, page.url()).toString());
  expect(iconResponse.ok(), `favicon ${icon} status ${iconResponse.status()}`).toBe(true);
  expect(iconResponse.headers()["content-type"] ?? "").toMatch(/image/);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref, "no manifest link in the page head").toBeTruthy();
  const manifestResponse = await request.get(new URL(manifestHref as string, page.url()).toString());
  expect(manifestResponse.ok(), `manifest ${manifestHref} status ${manifestResponse.status()}`).toBe(true);
  const manifest = (await manifestResponse.json()) as { name?: string; short_name?: string };
  expect(manifest.name).toBe("Dozo");
  expect(JSON.stringify(manifest)).not.toMatch(/rakazo|getrakazo|elie222/i);
});
