import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PASSWORD = "dozo-e2e-pass-12";

export function throwawayUser() {
  const id = Math.random().toString(36).slice(2, 10);
  return { email: `e2e-${id}@example.test`, name: `E2E ${id}`, password: PASSWORD };
}

/** Opens the email form when the server offers a provider chooser first. */
export async function openEmailForm(page: Page) {
  // Email-first sign-in shows the address alone with "Use a password instead"; a server without
  // emailed codes shows the password form, or a choice of providers with "Continue with email".
  const password = page.getByRole("button", { name: "Use a password instead" });
  const choice = page.getByRole("button", { name: "Continue with email" });
  const field = page.getByPlaceholder("Password");
  await expect(password.or(choice).or(field).first()).toBeVisible();
  if (await password.isVisible()) await password.click();
  else if (await choice.isVisible()) await choice.click();
  await expect(field).toBeVisible();
}

/** Fails with a clear message when the stack's auth limit (10 credential calls per 15 min per address) is hit. */
export function expectNotRateLimited(
  status: number,
  headers: Record<string, string>,
  what: string,
) {
  if (status === 429) {
    throw new Error(
      `${what} rate limited (429, retry-after ${headers["retry-after"] ?? "?"}s): too many credential calls in 15 minutes`,
    );
  }
}

export type Mail = { to?: string | string[]; subject?: string; text?: string; html?: string };

/**
 * Everything the stack's email emulator captured since the stack started. On a loaded machine the
 * whole mailbox can take long or arrive cut short through the web server; a caller that polls
 * reads it again.
 */
const readMailbox = (request: APIRequestContext) =>
  request.get("/api/dev/emails", { timeout: 30_000 });

/** What the stack's email emulator holds for `address`; empty on a stack that has none. */
export async function mailsTo(request: APIRequestContext, address: string): Promise<Mail[]> {
  const response = await readMailbox(request);
  if (!response.ok()) return [];
  const all = (await response.json()) as Mail[];
  return all.filter((mail) => [mail.to].flat().includes(address));
}

/** Whether this stack captures mail (started with DOZO_EMAIL_EMULATOR=1). */
export async function stackReadsMail(request: APIRequestContext) {
  return (await readMailbox(request)).ok();
}

/** The six digits of a sign-in code mail. */
export const codeIn = (mail: Mail | undefined) =>
  /\b(\d{6})\b/.exec(`${mail?.text ?? ""} ${mail?.html ?? ""}`)?.[1];

/** Waits for a sign-in code mail to `address` newer than the `before` mails already there. */
export async function codeAfter(request: APIRequestContext, address: string, before: number) {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        // The newest mail that holds a code: a refused password sign-in also sends a link mail,
        // and the two arrive in no fixed order, so the link mail is never the one read.
        const mails = await mailsTo(request, address);
        code =
          mails.length > before
            ? mails
                .filter((mail) => !linkIn(mail))
                .map(codeIn)
                .filter(Boolean)
                .at(-1)
            : undefined;
        return code;
      },
      { message: `a code mail to ${address}`, timeout: 60_000 },
    )
    .toMatch(/^\d{6}$/);
  return code as string;
}

/**
 * The verification link of a mail as a path on the stack under test (`/api/auth/verify-email?...`),
 * whatever host the mail names. The HTML form writes `&` as `&amp;`.
 */
export function linkIn(mail: Mail | undefined): string | undefined {
  const found = /https?:\/\/[^\s"'<>)\]]*\/api\/auth\/verify-email\?[^\s"'<>)\]]+/.exec(
    `${mail?.text ?? ""} ${mail?.html ?? ""}`,
  );
  if (!found) return undefined;
  const url = new URL(found[0].replaceAll("&amp;", "&"));
  return `${url.pathname}${url.search}`;
}

/** Waits for a verification mail to `address` newer than the `before` mails already there. */
export async function verificationLinkAfter(
  request: APIRequestContext,
  address: string,
  before: number,
) {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const mails = await mailsTo(request, address);
        link = mails.length > before ? linkIn(mails.at(-1)) : undefined;
        return link;
      },
      { message: `a verification mail to ${address}`, timeout: 60_000 },
    )
    .toBeTruthy();
  return link as string;
}

/**
 * Signs up through the real form. A stack that mails codes asks for a name and an address and then
 * the code, which makes the account (no password, no `sign-up/email` call), so the code is read
 * from the captured mail. A stack without codes shows upstream's form, which opens a session at
 * once.
 */
export async function signUpThroughForm(page: Page, user = throwawayUser()) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  const before = (await mailsTo(page.request, user.email)).length;
  if (capabilities.emailCode) {
    await page.getByPlaceholder("Your name").fill(user.name);
    await page.getByPlaceholder("Your email address").fill(user.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await page
      .getByLabel("Code", { exact: true })
      .fill(await codeAfter(page.request, user.email, before));
    await page.waitForURL(/\/(onboarding|app)/, { timeout: 30_000 });
    return user;
  }
  await openEmailForm(page);
  await page.getByPlaceholder("Your name").fill(user.name);
  await page.getByPlaceholder("Your email address").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  const signUp = page.waitForResponse((r) => r.url().includes("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await signUp;
  expectNotRateLimited(response.status(), response.headers(), "sign-up");
  expect(response.ok(), `sign-up answered ${response.status()}`).toBe(true);
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 30_000 });
  return user;
}

/** The OpenAI-compatible address of the model stub, as the api container reaches it. */
function modelUrl() {
  const url = process.env.DOZO_E2E_MODEL_URL;
  if (!url)
    throw new Error(
      "DOZO_E2E_MODEL_URL is not set; run the suite with e2e/run.sh, which starts the model stub",
    );
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
  // The form lists the server's models by itself once the address is in.
  await expect(page.getByText("dozo-e2e-model", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/app\/[^/?]+/, { timeout: 60_000 });
}
