import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PASSWORD = "dozo-e2e-pass-12";

export function throwawayUser() {
  const id = Math.random().toString(36).slice(2, 10);
  return { email: `e2e-${id}@example.test`, name: `E2E ${id}`, password: PASSWORD };
}

/** Opens the email form when the server offers a provider chooser first. */
export async function openEmailForm(page: Page) {
  const email = page.getByLabel("Email", { exact: true });
  const choice = page.getByRole("button", { name: "Continue with email" });
  await expect(email.or(choice)).toBeVisible();
  if (await choice.isVisible()) await choice.click();
}

/** Fails with a clear message when the stack's auth limit (10 credential calls per 15 min per address) is hit. */
export function expectNotRateLimited(status: number, headers: Record<string, string>, what: string) {
  if (status === 429) {
    throw new Error(
      `${what} rate limited (429, retry-after ${headers["retry-after"] ?? "?"}s): too many credential calls in 15 minutes`,
    );
  }
}

/** Signs up through the real form. Fails with a clear message when mail confirmation is required. */
export async function signUpThroughForm(page: Page, user = throwawayUser()) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await openEmailForm(page);
  await page.getByPlaceholder("Your name").fill(user.name);
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  const signUp = page.waitForResponse((r) => r.url().includes("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await signUp;
  expectNotRateLimited(response.status(), response.headers(), "sign-up");
  expect(response.ok(), `sign-up answered ${response.status()}`).toBe(true);
  const landed = page.waitForURL(/\/(onboarding|app)/, { timeout: 30_000 });
  const verify = page.getByRole("heading", { name: "Check your email" });
  await Promise.race([landed, verify.waitFor({ timeout: 30_000 })]);
  if (await verify.isVisible().catch(() => false)) {
    throw new Error("sign-up needs mail confirmation; this stack cannot create an account without it");
  }
  return user;
}

/** The OpenAI-compatible address of the model stub, as the api container reaches it. */
export function modelUrl() {
  const url = process.env.DOZO_E2E_MODEL_URL;
  if (!url) throw new Error("DOZO_E2E_MODEL_URL is not set; run the suite with e2e/run.sh, which starts the model stub");
  return url;
}

/**
 * Connects the stub as an OpenAI-compatible model through the real onboarding step, which is what
 * a person without a hosted provider does. The first bot is then created and greets with the stub's reply.
 */
export async function connectModelThroughOnboarding(page: Page) {
  await page.goto("/onboarding/model");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "OpenAI-compatible", exact: true }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill(modelUrl());
  await page.getByRole("button", { name: "Find models" }).click();
  await expect(page.getByText("Found 1 model.")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\/[^/?]+/, { timeout: 60_000 });
}
