import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Small helpers over the app's own test ids; the same ones upstream's e2e uses. */

/**
 * Navigates, retrying a navigation or a page asset that never answered. Through the docker port
 * forwarder an occasional request stalls (a document, or a script chunk that leaves the page on its
 * loading spinner); that is the path to the stack, not the app, and a second attempt gets through.
 */
export async function gotoStable(page: Page, path: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(path, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="page-loading"],[data-rakazo-app-state="session-pending"]') === null,
        undefined,
        { timeout: 15_000 },
      );
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export async function openBot(page: Page, botId: string, name: string) {
  for (let attempt = 1; ; attempt++) {
    await gotoStable(page, `/app/${botId}`);
    try {
      await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible({ timeout: 12_000 });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** Opens the bot panel (profile, computer, routines, settings) from the header pill. */
export async function openBotPanel(page: Page) {
  const pill = page.getByTestId("bot-settings-trigger");
  const profile = page.getByTestId("bot-settings").getByTestId("bot-profile-header");
  await expect(async () => {
    if (!(await profile.isVisible())) {
      if ((await pill.getAttribute("aria-expanded")) === "true") {
        await pill.click();
        await expect(pill).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 });
      }
      await pill.click();
    }
    await expect(profile).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Opens the bot panel and unfolds its Settings (model, switches, instructions, memory). */
export async function openBotSettings(page: Page) {
  await openBotPanel(page);
  const toggle = page.getByTestId("bot-settings-advanced").locator("button[aria-expanded]").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

export type SettingsId =
  | "general" | "models" | "confirmations" | "vault" | "memory" | "voice" | "labs" | "usage" | "organization"
  | "wallet" | "messaging" | "computer" | "billing" | "updates";

/** Opens account Settings from the account menu, and one of its sections. */
export async function openUserSettings(page: Page, section: SettingsId = "general") {
  const settings = page.getByTestId("user-settings");
  for (let attempt = 1; ; attempt++) {
    if (!new URL(page.url()).searchParams.has("settings")) {
      await page.getByTestId("user-menu-trigger").click();
      await page
        .locator('[data-slot="popover-content"]')
        .getByRole("button", { name: "Settings", exact: true })
        .click();
    }
    try {
      await expect(settings).toBeVisible({ timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await page.keyboard.press("Escape");
    }
  }
  if (section !== "general") await settings.getByTestId(`settings-nav-${section}`).click();
  await expect(settings).toHaveAttribute("data-settings-section", section);
  return settings;
}

export async function closeUserSettings(page: Page) {
  await page.getByRole("button", { name: "Close user settings" }).click();
  await expect(page.getByTestId("user-settings")).toBeHidden();
}

export async function openAccountMenu(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu).toBeVisible();
  return menu;
}

export async function openCommandPalette(page: Page) {
  await page.locator("body").click({ position: { x: 700, y: 400 } });
  await page.keyboard.press("Control+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  return palette;
}

export async function openCreateMenu(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
}

/** Closes the topmost popup (menu, picker, small dialog) with one Escape. */
export async function dismiss(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

export async function visible(locator: Locator) {
  await expect(locator.first()).toBeVisible();
}

/** Unfolds every collapsed section inside `scope`, one at a time (menus and pickers are left alone). */
export async function expandAll(page: Page, scope: Locator) {
  for (let round = 0; round < 15; round++) {
    const closed = scope.locator('button[aria-expanded="false"]:not([aria-haspopup])');
    if ((await closed.count()) === 0) return;
    await closed.first().scrollIntoViewIfNeeded();
    await closed.first().click();
    await page.waitForTimeout(200);
  }
}

/**
 * Brings the bot's computer up from its panel, however it was left: "Retry screen" after a failed
 * start, "Wake" when asleep, nothing when already "Awake". Waits for a start to finish.
 */
export async function ensureComputerAwake(page: Page) {
  const awake = page.getByText("Awake", { exact: true });
  await expect(async () => {
    if (await awake.isVisible()) return;
    const retry = page.getByRole("button", { name: "Retry screen" });
    const wake = page.getByTestId("computer-preview-open").filter({ hasText: "Wake" });
    if (await retry.isVisible()) await retry.click();
    else if (await wake.isVisible()) await wake.click();
    await expect(awake).toBeVisible({ timeout: 25_000 });
  }).toPass({ timeout: 200_000 });
}

/** Opens every menu, picker and dropdown trigger inside `scope` once, so each one's options are scanned. */
export async function openEachPopup(page: Page, scope: Locator, scan: (label: string) => Promise<void>, label: string) {
  const triggers = scope.locator('button[aria-haspopup], [role="combobox"]:not(select)');
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const trigger = triggers.nth(i);
        if (!(await trigger.isVisible().catch(() => false))) break;
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const popup = page.locator('[role="listbox"],[role="menu"],[data-slot="popover-content"],[data-slot="select-content"]').last();
        if (await popup.isVisible().catch(() => false)) {
          await scan(`${label}, popup ${i + 1}`);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
        }
        break;
      } catch (error) {
        // The page re-rendered under the trigger; look it up again once.
        if (attempt === 2) throw error;
        await page.waitForTimeout(500);
      }
    }
  }
}
