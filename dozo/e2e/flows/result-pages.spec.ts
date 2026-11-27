import type { Page } from "@playwright/test";
import { APPEARANCE_KEY } from "../fixtures";
import { outDir } from "../scan";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * The pages a flow ends on when it leaves the app (a sign-in popup, an OAuth return, a link that
 * leads nowhere, an unknown address): each keeps the sign-in column's frame, has one heading and
 * exactly one way on, and is saved to `<out>/shots/results/` in both themes.
 */
const THEMES = ["dark", "light"] as const;

const SIGNED_OUT_PAGES = [
  ["not-found", "/no-such-page", "Page not found", "Go home"],
  ["shared-page-gone", "/p/not-a-real-page", "This page isn't available", "Open Dozo"],
  [
    "integration-callback",
    "/integrations/callback",
    "You can close this window.",
    "Return to Dozo",
  ],
  ["sso-callback", "/sso/callback", "You can close this window.", "Return to Dozo"],
] as const;

async function check(
  page: Page,
  theme: string,
  [state, path, title, action]: readonly [string, string, string, string],
) {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [APPEARANCE_KEY, theme] as const,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator('[data-rakazo-surface="auth"] a[data-dozo-onward]')).toHaveText(action);
  await expect(page.locator("form a, form button")).toHaveCount(1);
  await page.screenshot({ path: `${outDir()}/shots/results/${state}-${theme}.png` });
}

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });
  for (const theme of THEMES)
    for (const spec of SIGNED_OUT_PAGES)
      test(`result page ${spec[0]} (${theme})`, async ({ page, guard }) => {
        guard.allow(/^(400|401|404) /, "the address is made up for the picture");
        await check(page, theme, spec);
      });
});
