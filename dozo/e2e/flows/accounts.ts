import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import { outDir } from "../scan";
import { PASSWORD } from "../support";

/** The stack's admin, signed up and verified by run.sh (RAKAZO_ADMIN_EMAILS, first address). */
export const ADMIN = {
  email: process.env.DOZO_E2E_ADMIN_EMAIL ?? "",
  password: process.env.DOZO_E2E_ADMIN_PASSWORD ?? "",
};

export const BASE = process.env.DOZO_E2E_BASE_URL ?? "http://127.0.0.1:5173";
const VIEWPORT = { width: 1440, height: 900 };

/** An address no other run uses: `<prefix>-<random>@example.test`. */
export function uniqueEmail(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

async function authCall(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api/auth/${path}`, {
    data,
    headers: { origin: BASE },
  });
  expect(response.status(), `${path} answered ${response.status()}`).toBe(200);
}

/** A browser of its own, signed in through the auth API (one credential call). */
export async function signedInAs(
  browser: Browser,
  email: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE, viewport: VIEWPORT });
  const page = await context.newPage();
  await authCall(page, "sign-in/email", { email, password });
  return { context, page };
}

/** A new account through the auth API, in a browser of its own (one credential call). */
export async function newAccount(browser: Browser, prefix: string) {
  const user = { email: uniqueEmail(prefix), name: `E2E ${prefix}`, password: PASSWORD };
  const context = await browser.newContext({ baseURL: BASE, viewport: VIEWPORT });
  const page = await context.newPage();
  await authCall(page, "sign-up/email", user);
  return { context, page, user };
}

/**
 * A browser signed in as the admin. The session is made once per run and reused, so the admin
 * scenarios spend one of the stack's 10 sign-ins per 15 minutes, not one each.
 */
export async function adminBrowser(browser: Browser) {
  expect(ADMIN.email, "no admin on this stack: run make up again, then make e2e").not.toBe("");
  const state = `${outDir()}/admin-state.json`;
  if (existsSync(state)) {
    const context = await browser.newContext({
      baseURL: BASE,
      viewport: VIEWPORT,
      storageState: state,
    });
    return { context, page: await context.newPage() };
  }
  const signedIn = await signedInAs(browser, ADMIN.email, ADMIN.password);
  await signedIn.context.storageState({ path: state });
  return signedIn;
}

/** An RPC through a page's session, as the app's own client sends it. */
export async function rpcAs<T>(page: Page, procedure: string, body: unknown = null): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T };
  expect(response.ok(), `${procedure} answered ${response.status()}`).toBe(true);
  return parsed.json as T;
}

type PlanRow = {
  tier: "standard" | "pro" | "max";
  name: string;
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  computerHours: { value: number | null };
};

/** The plans as the server holds them (names, prices, hours), read with the admin's session. */
export async function serverPlans(browser: Browser): Promise<PlanRow[]> {
  const { context, page } = await adminBrowser(browser);
  try {
    return (await rpcAs<{ plans: PlanRow[] }>(page, "dozoAdmin/plans/list")).plans;
  } finally {
    await context.close();
  }
}

/**
 * The stack has no payment provider, so the billing answers are faked in this browser only: the
 * server's own plans (names and prices read from it, never invented here) on a Free account that
 * may subscribe. A checkout is recorded and answered with the address a person lands on when they
 * leave the payment page without paying (`?billing=canceled`).
 */
export async function fakeBilling(page: Page, plans: PlanRow[]) {
  const checkouts: unknown[] = [];
  const patchMe = async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: Record<string, unknown> };
    const me = route.request().url().endsWith("/me")
      ? body.json
      : (body.json?.me as Record<string, unknown> | undefined);
    if (me) me.billingEnabled = true;
    await route.fulfill({ response, json: body });
  };
  await page.route("**/rpc/me", patchMe);
  await page.route("**/rpc/bootstrap", patchMe);
  const sizes: Record<string, string> = { pro: "large", max: "xlarge" };
  await page.route("**/rpc/billing/status", (route) =>
    route.fulfill({
      json: {
        json: {
          funding: "byok",
          balanceUsd: 0,
          byokPriceCents: null,
          byokTier: "standard",
          byokTiers: plans
            .filter((plan) => plan.tier !== "standard" && plan.monthlyPriceCents)
            .map((plan) => ({
              tier: plan.tier,
              name: plan.name,
              monthlyPriceCents: plan.monthlyPriceCents,
              annualPriceCents: plan.annualPriceCents,
              computerSize: sizes[plan.tier],
              computerHours: plan.computerHours.value ?? 0,
            })),
          byokFreeUntil: null,
          access: true,
          canManage: true,
          trialAvailable: false,
          trialDays: 0,
          state: "none",
          price: null,
          seats: 1,
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          cancelAtPeriodEnd: false,
          hasCustomer: false,
          computerHoursLeft: 0,
          computerHoursResetAt: null,
          referral: null,
        },
      },
    }),
  );
  await page.route("**/rpc/billing/checkout", async (route) => {
    checkouts.push((route.request().postDataJSON() as { json?: unknown }).json);
    await route.fulfill({ json: { json: { url: `${BASE}/app?billing=canceled` } } });
  });
  return { checkouts };
}

/** The money the plan card shows for an amount in cents: `$49`, `$468`. */
export function dollars(cents: number | null) {
  return `$${((cents ?? 0) / 100).toFixed(0)}`;
}
