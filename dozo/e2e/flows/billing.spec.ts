import type { Locator } from "@playwright/test";
import { readWorld } from "../fixtures";
import { openBot } from "../ui";
import { dollars, fakeBilling, newAccount, serverPlans } from "./accounts";
import { expect, test } from "./flow";

/**
 * Billing as a person meets it. The stack has no payment provider, so the server's billing answers
 * are faked in the browser (accounts.ts, `fakeBilling`) from the server's own plans; the live
 * server's refusal of a checkout is `make canli`'s. What is checked here is the app's side: the
 * plan screen with Premium coming soon, a plan picked on an older landing link, the return without
 * paying, and a full shared space. Free's computer refusal comes from the server's computer state,
 * which a browser fake cannot give faithfully: `make canli` checks it on a real Free account.
 */

/**
 * What Free sees where a plan that is not on sale would be subscribed to: the plan's name and
 * monthly price, each on its own, beside a disabled Coming soon.
 */
async function expectComingSoon(
  settings: Locator,
  plan: { name: string; monthlyPriceCents: number | null } | undefined,
) {
  await expect(settings.getByRole("button", { name: "Coming soon", exact: true })).toBeDisabled();
  const card = settings.getByTestId("plan-card");
  await expect(card.getByText(plan?.name as string, { exact: true })).toBeVisible();
  await expect(
    card.getByText(`${dollars(plan?.monthlyPriceCents ?? null)} / month`, { exact: true }),
  ).toBeVisible();
}

test("plan screen: Premium at the server's price, coming soon, and nothing to subscribe to", async ({
  page,
  browser,
}) => {
  const plans = await serverPlans(browser);
  const premium = plans.find((p) => p.tier === "pro");
  expect(premium?.onSale, "Premium is not on sale yet").toBe(false);
  expect(plans.find((p) => p.tier === "max")?.offered, "no Premium Plus offer").toBe(false);
  const billing = await fakeBilling(page, plans);
  await openBot(page, readWorld().chiefId, "Chief");
  await page.goto("/app?settings=billing");
  const settings = page.getByTestId("user-settings");
  await expectComingSoon(settings, premium);
  await expect(settings.getByRole("button", { name: /^Subscribe for/ })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: /^Yearly/ })).toHaveCount(0);
  await expect(settings.getByText("Premium Plus")).toHaveCount(0);
  expect(billing.checkouts).toEqual([]);
});

test("plan picked on an older landing link: Billing opens on it, coming soon, no checkout", async ({
  browser,
  guard,
}) => {
  const plans = await serverPlans(browser);
  const { page } = await newAccount(browser, "intent");
  guard.follow(page);
  guard.allow(/404 POST [^ ]*\/rpc\/billing\/status/, "before the fake is installed");
  const billing = await fakeBilling(page, plans);
  // The landing page's links name no plan now; an older Premium link still may.
  await page.goto("/sign-in?plan=premium&period=year");
  // A new account has no model yet: the model step comes first, and "Later" goes on to the app.
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Later" }).click();
  await expect(page).toHaveURL(/settings=billing/);
  const settings = page.getByTestId("user-settings");
  const premium = plans.find((p) => p.tier === "pro");
  await expectComingSoon(settings, premium);
  await expect(settings.getByRole("button", { name: /^Subscribe for/ })).toHaveCount(0);
  expect(billing.checkouts).toEqual([]);
});

test("?billing=canceled: back from the payment page, Billing opens again", async ({
  page,
  browser,
}) => {
  await fakeBilling(page, await serverPlans(browser));
  await openBot(page, readWorld().chiefId, "Chief");
  await page.goto("/app?billing=canceled");
  await expect(page).toHaveURL(/settings=billing/);
  await expect(page).not.toHaveURL(/billing=canceled/);
  await expect(page.getByTestId("user-settings")).toBeVisible();
});

test("plan limit: a full shared space refuses the upload and says so", async ({
  page,
  browser,
  guard,
}) => {
  guard.allow(/400 POST [^ ]*\/rpc\/artifacts\/create/, "the refusal under test (faked)");
  await fakeBilling(page, await serverPlans(browser));
  // The server's own refusal when the organization's files fill its plan's shared space.
  await page.route("**/rpc/artifacts/create", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: {
          defined: false,
          code: "shared_space_full",
          status: 400,
          message: "Shared space is full. Delete files or change the plan.",
        },
      },
    }),
  );
  await openBot(page, readWorld().chiefId, "Chief");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "e2e.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("e2e"),
    });
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("With a file");
  await composer.press("Enter");
  await expect(page.getByText(/^Shared space is full/).first()).toBeVisible();
});
