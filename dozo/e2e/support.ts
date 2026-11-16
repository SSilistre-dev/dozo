import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

export { expect, test } from "@playwright/test";

export const PASSWORD = "dozo-e2e-pass-12";

export function throwawayUser() {
  const id = Math.random().toString(36).slice(2, 10);
  return { email: `e2e-${id}@example.test`, name: `E2E ${id}`, password: PASSWORD };
}

/** Signs up through the real form. Fails with a clear message when mail confirmation is required. */
export async function signUpThroughForm(page: Page, user = throwawayUser()) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  const email = page.getByLabel("Email", { exact: true });
  const choice = page.getByRole("button", { name: "Continue with email" });
  await expect(email.or(choice)).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("Your name").fill(user.name);
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  const signUp = page.waitForResponse((r) => r.url().includes("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await signUp;
  if (response.status() === 429) {
    // The stack allows 10 credential requests per 15 minutes per address; one run uses 4.
    throw new Error(
      `sign-up rate limited (429, retry-after ${response.headers()["retry-after"] ?? "?"}s): too many runs in 15 minutes`,
    );
  }
  expect(response.ok(), `sign-up answered ${response.status()}`).toBe(true);
  const landed = page.waitForURL(/\/(onboarding|app)/, { timeout: 30_000 });
  const verify = page.getByRole("heading", { name: "Check your email" });
  await Promise.race([landed, verify.waitFor({ timeout: 30_000 })]);
  if (await verify.isVisible().catch(() => false)) {
    throw new Error("sign-up needs mail confirmation; this stack cannot create an account without it");
  }
  return user;
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  // `rakazo.uiAppearance` is a deliberately unchanged technical identifier.
  await page.evaluate((value) => localStorage.setItem("rakazo.uiAppearance", value), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/**
 * Deliberately unchanged technical identifiers, allowed ONLY inside attribute and link values
 * (never in visible text): `@rakazo/*`, `RAKAZO_*`, `x-rakazo-*` and the `rakazo://` scheme.
 * Placeholders `dozo.example` and `github.com/OWNER/dozo` never match the leak pattern.
 */
const KNOWN_IDENTIFIERS = [/@rakazo\/[\w.-]+/gi, /RAKAZO_\w+/g, /x-rakazo-[\w-]+/gi, /rakazo:\/\//gi];
const LEAK = /rakazo|getrakazo|elie222/i;

export type Leak = { screen: string; where: string; text: string };

/** Every place a person can read a name: visible text and the named attributes. */
export async function findBrandLeaks(page: Page, screen: string): Promise<Leak[]> {
  const found = await page.evaluate(() => {
    const attrs = ["alt", "title", "aria-label", "placeholder"];
    const items: { where: string; text: string }[] = [];
    items.push({ where: "body.innerText", text: document.body.innerText });
    for (const attr of attrs) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        items.push({ where: `[${attr}]`, text: el.getAttribute(attr) ?? "" });
      }
    }
    for (const a of document.querySelectorAll("a[href]")) {
      items.push({ where: "a[href]", text: a.getAttribute("href") ?? "" });
    }
    return items;
  });
  const leaks: Leak[] = [];
  for (const item of found) {
    let text = item.text;
    if (item.where !== "body.innerText") for (const known of KNOWN_IDENTIFIERS) text = text.replace(known, "");
    const match = LEAK.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 30);
      leaks.push({ screen, where: item.where, text: text.slice(start, match.index + 40).replace(/\s+/g, " ") });
    }
  }
  return leaks;
}

export async function expectBranded(page: Page, screen: string) {
  await expect(page).toHaveTitle(/Dozo/);
  const leaks = await findBrandLeaks(page, screen);
  expect(
    leaks,
    leaks.map((l) => `screen "${l.screen}", ${l.where}: "${l.text}"`).join("\n"),
  ).toEqual([]);
}

export async function openSettings(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  return settings;
}

export async function settingsSections(page: Page) {
  const ids = await page
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")?.slice("settings-nav-".length) ?? ""));
  return ids.filter(Boolean);
}

/** The app shell (and with it Settings) opens only once the account has a model; onboarding otherwise. */
export async function shellReachable(page: Page) {
  await page.goto("/app");
  await page.waitForURL(/\/(app|onboarding)/);
  await page.waitForLoadState("networkidle");
  return new URL(page.url()).pathname.startsWith("/app");
}

/** Makes a skipped part visible in the run output instead of passing silently. */
export function notCovered(reason: string) {
  console.log(`NOT COVERED: ${reason}`);
  test.info().annotations.push({ type: "not-covered", description: reason });
}
