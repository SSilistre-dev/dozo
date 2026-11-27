import type { Page } from "@playwright/test";
import { APPEARANCE_KEY } from "../fixtures";
import { outDir } from "../scan";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * Every signed-out account screen in both themes, at a desktop and a phone width, in English and
 * Turkish: each is saved to `<out>/shots/auth/` and held to the same layout rules. The rules are
 * what the shots showed once: nothing overflows the width, the one onward control fits the
 * column and not the page, and a result page carries one heading and one next step.
 *
 * run.sh makes the verification links (a valid and an expired one) with the api's own secret.
 */
test.use({ storageState: SIGNED_OUT });

const LINK = process.env.DOZO_E2E_VERIFY_LINK ?? "";
const EXPIRED = process.env.DOZO_E2E_VERIFY_EXPIRED ?? "";
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

type Variant = { theme: "light" | "dark"; size: keyof typeof VIEWPORTS; lang: "en" | "tr" };
const VARIANTS: Variant[] = (["light", "dark"] as const).flatMap((theme) =>
  (["desktop", "phone"] as const).flatMap((size) =>
    (["en", "tr"] as const).map((lang) => ({ theme, size, lang })),
  ),
);

async function open(page: Page, path: string, lang: string) {
  // A mail's link keeps its own address; the language saved by the earlier pages still applies.
  const separator = path.includes("?") ? "&" : "?";
  await page.goto(path.startsWith("http") ? path : `${path}${separator}lang=${lang}`);
  await page.evaluate(() => document.fonts.ready);
}

/** The layout rules every screen of the family keeps. */
async function holdLayout(page: Page, label: string) {
  const facts = await page.evaluate(() => {
    const root = document.documentElement;
    const form = document.querySelector<HTMLElement>('[data-rakazo-surface="auth"] form');
    const primary = document.querySelector<HTMLElement>(
      '[data-rakazo-surface="auth"] form [data-slot="button"][type="submit"], [data-rakazo-surface="auth"] form a[data-dozo-onward]',
    );
    return {
      overflow: root.scrollWidth - root.clientWidth,
      form: form?.getBoundingClientRect().width ?? 0,
      primary: primary?.getBoundingClientRect().width ?? 0,
      headings: document.querySelectorAll("h1").length,
    };
  });
  expect(facts.overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  expect(facts.headings, `${label}: headings`).toBe(1);
  expect(facts.primary, `${label}: the button is wider than the column`).toBeLessThanOrEqual(
    facts.form,
  );
}

for (const variant of VARIANTS) {
  const name = `${variant.theme}-${variant.size}-${variant.lang}`;
  test(`auth screens: ${name}`, async ({ page, guard }) => {
    expect(LINK && EXPIRED, "run.sh makes the verification links").toBeTruthy();
    guard.allow(/^(400|401|404|422|429) /, "refused attempts and absent mail are the point here");
    await page.setViewportSize(VIEWPORTS[variant.size]);
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [APPEARANCE_KEY, variant.theme] as const,
    );
    const shoot = async (state: string) => {
      await holdLayout(page, `${state} (${name})`);
      await page.screenshot({ path: `${outDir()}/shots/auth/${state}-${name}.png` });
    };
    const mail = (
      await (await page.request.get("/api/auth/capabilities")).json()
    ).emailCode as boolean;

    await open(page, "/sign-in", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("sign-in");
    if (mail) {
      await page.getByRole("textbox").first().fill("someone-e2e@example.test");
      await page.locator('form button[type="submit"]').first().click();
      await expect(page.locator("[data-dozo-code]")).toBeVisible();
      await shoot("sign-in-code");
    }

    await open(page, "/sign-up", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("sign-up");

    await open(page, "/sign-in/email", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("sign-in-password");

    await open(page, "/forgot-password", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("forgot-password");
    await page.getByRole("textbox").first().fill("someone-e2e@example.test");
    await page.locator('form button[type="submit"]').click();
    // The answer replaces the form, whether the server mailed the link or said it cannot.
    await expect(page.locator('form button[type="submit"]')).toHaveCount(0);
    await shoot("forgot-password-answer");

    await open(page, "/reset-password?token=e2e-not-a-token", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("reset-password");
    await open(page, "/reset-password", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("reset-link-invalid");

    // A link opened signed out verifies nothing (the server holds it), so "verified" is shown the
    // way the server answers for an account that already is: the mark's own word.
    await page.route("**/api/auth/dozo/email-link*", (route) =>
      route.fulfill({ json: { verified: true, email: "someone-e2e@example.test" } }),
    );
    await open(page, "/verify-email?v=e2e-mark", variant.lang);
    await expect(page.getByRole("heading")).toBeVisible();
    await shoot("verified");
    await page.unroute("**/api/auth/dozo/email-link*");

    for (const [state, link] of [
      ["expired", EXPIRED],
      ["link-invalid", "/verify-email?error=INVALID_TOKEN"],
      ["link-unknown", "/verify-email?error=SOMETHING_ELSE"],
      ["link-neutral", "/verify-email?v=e2e-forged"],
    ] as const) {
      await open(page, link, variant.lang);
      await expect(page.getByRole("heading")).toBeVisible();
      await shoot(state);
    }
  });
}

test.describe("on a phone", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
  });

  test("the verified page offers the way back to the app", async ({ page, guard }) => {
    guard.allow(/^(400|401|404) /, "the link is made up for the picture");
    await page.setViewportSize(VIEWPORTS.phone);
    await page.route("**/api/auth/dozo/email-link*", (route) =>
      route.fulfill({ json: { verified: true, email: "someone-e2e@example.test" } }),
    );
    await page.goto("/verify-email?v=e2e-mark");
    await expect(page.getByRole("link", { name: "Open Dozo" })).toHaveAttribute("href", "dozo://");
    await holdLayout(page, "verified on a phone");
    await page.screenshot({ path: `${outDir()}/shots/auth/verified-app-phone-en.png` });
  });
});
