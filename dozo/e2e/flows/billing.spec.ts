import { readWorld } from "../fixtures";
import { openBot } from "../ui";
import { dollars, fakeBilling, newAccount, serverPlans } from "./accounts";
import { expect, test } from "./flow";

/**
 * Billing as a person meets it. The stack has no payment provider, so the server's billing answers
 * are faked in the browser (accounts.ts, `fakeBilling`) from the server's own plans; the real
 * payment page is `make canli`'s. What is checked here is the app's side: the plan screen, the
 * plan picked on the landing page, the return without paying, the checkout it asks for, and a full
 * shared space. Free's computer refusal comes from the server's computer state, which a browser
 * fake cannot give faithfully: `make canli` checks it on a real Free account.
 */

test("plan screen: the server's plans and prices, monthly and yearly", async ({
  page,
  browser,
}) => {
  const plans = await serverPlans(browser);
  await fakeBilling(page, plans);
  await openBot(page, readWorld().chiefId, "Chief");
  await page.goto("/app?settings=billing");
  const settings = page.getByTestId("user-settings");
  const premium = plans.find((p) => p.tier === "pro");
  const plus = plans.find((p) => p.tier === "max");
  const subscribe = settings.getByRole("button", { name: /^Subscribe for/ });
  await expect(subscribe).toContainText(`${dollars(premium?.monthlyPriceCents ?? null)} / month`);
  await settings.getByRole("button", { name: /^Yearly/ }).click();
  await expect(subscribe).toContainText(`${dollars(premium?.annualPriceCents ?? null)} / year`);
  // The plan picker starts on the first paid plan; the landing-page test below picks the other one.
  await expect(settings.getByText(premium?.name as string, { exact: true }).first()).toBeVisible();
  expect(plus, "the server sells a second paid plan").toBeTruthy();
});

test("plan picked on the landing page: sign-up opens Billing with it, checkout asks for it", async ({
  browser,
  guard,
}) => {
  const plans = await serverPlans(browser);
  const { page } = await newAccount(browser, "intent");
  guard.follow(page);
  guard.allow(/404 POST [^ ]*\/rpc\/billing\/status/, "before the fake is installed");
  const billing = await fakeBilling(page, plans);
  // The landing page's Premium Plus card, yearly. The pick is read on the sign-in/sign-up page.
  await page.goto("/sign-in?plan=premium_plus&period=year");
  // A new account has no model yet: the model step comes first, and "Later" goes on to the app.
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Later" }).click();
  await expect(page).toHaveURL(/settings=billing/);
  const settings = page.getByTestId("user-settings");
  const plus = plans.find((p) => p.tier === "max");
  const subscribe = settings.getByRole("button", { name: /^Subscribe for/ });
  await expect(subscribe).toContainText(`${dollars(plus?.annualPriceCents ?? null)} / year`);
  await subscribe.click();
  // The fake checkout sends the person back as the payment page's Back does.
  await expect(page).toHaveURL(/settings=billing/);
  await expect(page).not.toHaveURL(/billing=canceled/);
  expect(billing.checkouts).toEqual([{ interval: "year", tier: "max" }]);
  await expect(settings.getByText(plus?.name as string, { exact: true }).first()).toBeVisible();
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
