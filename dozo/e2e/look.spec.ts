import type { Page } from "@playwright/test";
import { expect, readWorld, test, UPSTREAM_AVATAR_ART } from "./fixtures";
import { gotoStable, openBot } from "./ui";

// The Dozo look on the screens the design mockups cover (dozo/design), in both themes. Each check
// reads a hook the fork's stylesheet or avatar wrapper relies on (a data attribute or a class of
// upstream's), so an upstream merge that renames one fails here instead of silently dropping the look.

const INNER = '[data-slot="sidebar-inner"]';
const HEADER = `${INNER} > .app-drag:first-child`;
const ROW = "[data-roster-bot-id]";
const CLEAR = "rgba(0, 0, 0, 0)";

/** A computed style value of the first match, or of one of its pseudo-elements. */
function styleOf(page: Page, selector: string, property: string, pseudo?: string) {
  return page.evaluate(
    ([sel, prop, pse]) => {
      const element = document.querySelector(sel as string);
      if (!element) throw new Error(`no element matches ${sel}`);
      return getComputedStyle(element, pse ?? undefined).getPropertyValue(prop as string);
    },
    [selector, property, pseudo ?? null],
  );
}

test("the theme file is loaded and follows the chosen appearance", async ({ page, theme }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const response = await page.request.get("/instance-theme.css");
  expect(response.ok(), `instance theme answered ${response.status()}`).toBe(true);
  const block = (await response.text()).match(
    new RegExp(`html\\[data-theme="${theme}"\\] \\{([^}]*)\\}`),
  )?.[1];
  const declared = block?.match(/--background: (#[0-9a-f]+);/i)?.[1];
  expect(declared, `the theme sets no ${theme} background`).toBeTruthy();
  const applied = (await styleOf(page, "html", "--background")).trim();
  expect(applied.toLowerCase()).toBe(declared?.toLowerCase());
});

test("the sidebar shows Dozo characters in pill rows under the wordmark and the pattern", async ({
  page,
}) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  const rows = page.locator(ROW);
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(`${ROW} > .dozo-avatar`)).toHaveCount(await rows.count());
  await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);

  // One-line rows with the small avatar, fully rounded, like every button.
  expect(await styleOf(page, ROW, "border-radius")).toBe("999px");
  expect(await styleOf(page, `${ROW} > .dozo-avatar`, "width")).toBe("28px");
  expect(await styleOf(page, `${INNER} [data-slot="button"]`, "border-radius")).toBe("999px");

  // The wordmark with its seal dot starts the header (a browser has no window controls, so their
  // spacer is dropped), and the wave pattern lies behind the top of the sidebar.
  expect((await page.getByTestId("bots-sidebar").boundingBox())?.width).toBe(240);
  expect(await styleOf(page, `${HEADER} > [aria-hidden="true"]`, "display")).toBe("none");
  expect(await styleOf(page, HEADER, "content", "::before")).toBe('"dozo"');
  expect(await styleOf(page, HEADER, "background-image", "::before")).toContain("radial-gradient");
  expect(await styleOf(page, INNER, "mask-image", "::before")).toContain("data:image/svg+xml");
  expect(await styleOf(page, INNER, "opacity", "::before")).toBe("1");

  // The open bot's row is tinted by its avatar; the other rows are not.
  const open = `${ROW}[aria-current="page"]`;
  await expect(page.locator(open)).toHaveCount(1);
  expect(await styleOf(page, open, "background-color")).toBe(CLEAR);
  const tint = await styleOf(page, `${open} > .dozo-avatar`, "background-color", "::before");
  expect(tint).not.toBe(CLEAR);
  expect(tint).toMatch(/0\.14\)$/);
  expect(
    await styleOf(page, `${ROW}:not([aria-current]) > .dozo-avatar`, "content", "::before"),
  ).toBe("none");
});

test("the chat is a narrow column with plain bot text and theme-coloured controls", async ({
  page,
}) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const bubble = page.getByTestId("message-bot-bubble").first();
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveCSS("background-color", CLEAR);
  await expect(bubble).toHaveCSS("padding-left", "0px");
  const column = (await page.getByTestId("composer-bar").boundingBox())?.width ?? 0;
  expect(column).toBeGreaterThan(400);
  expect(column).toBeLessThanOrEqual(720);
  expect(await styleOf(page, '[data-testid="transcript"]', "padding-left")).toBe(
    await styleOf(page, 'fieldset:has(> [data-testid="composer-bar"])', "padding-left"),
  );

  // The send button is the theme's primary, not the bot's upstream colour.
  const draft = page.getByRole("combobox", { name: "Message Chief" });
  await draft.fill("hello");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  expect(await send.getAttribute("class")).not.toContain("bg-chat-user");
  expect(await send.getAttribute("style")).toBeNull();
  await draft.fill("");
});

test("the chat header and the bot panel show the bot's character", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const trigger = page.getByTestId("bot-settings-trigger");
  await expect(trigger.locator(".dozo-avatar")).toBeVisible();
  await trigger.click();
  const profile = page.getByTestId("bot-profile-header");
  await expect(profile.locator(".dozo-avatar").first()).toBeVisible();
  await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the sign-in mascot is Sora, awake", async ({ page }) => {
    await gotoStable(page, "/sign-in");
    const mascot = page.locator('.dozo-avatar[data-character="sora"]');
    await expect(mascot).toBeVisible();
    await expect(mascot).toHaveAttribute("data-state", "waiting");
    expect((await mascot.boundingBox())?.width).toBe(74);
    await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);
    await expect(page.locator('[data-slot="button"]').first()).toHaveCSS("border-radius", "999px");
  });

  test("a first visit with no stored choice is dark, even on a light system", async ({
    browser,
    theme,
  }, testInfo) => {
    test.skip(theme !== "light", "does not depend on the project's theme");
    // A context of its own: the suite's fixture stores an appearance before the page loads.
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await gotoStable(page, "/sign-in");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".dozo-avatar")).toBeVisible();
    await context.close();
  });
});
