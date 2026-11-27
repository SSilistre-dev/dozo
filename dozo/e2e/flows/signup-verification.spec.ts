import type { Page } from "@playwright/test";
import { codeAfter, mailsTo, PASSWORD, verificationLinkAfter } from "../support";
import {
  BASE,
  dollars,
  emailFormTr,
  fakeBilling,
  openPasswordFormTr,
  serverPlans,
  uniqueEmail,
} from "./accounts";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * Mailbox first: on a server with a mail provider sign-up asks for a name, an address and a code
 * (no password), a password sign-up through the API opens no session, and an unverified account
 * cannot sign in with its password (the page then sends a code). Needs the email emulator
 * (DOZO_EMAIL_EMULATOR=1, see dozo/docker/README.md) to read the mail; a stack that sends no mail
 * skips this, and there sign-up opens a session at once (auth.spec.ts, verify.spec.ts).
 *
 * New addresses only; each test starts signed out. Turkish for the sign-up form and the link and
 * password path, English for the emailed-code sign-in (as code-sign-in.spec.ts) and for the plan
 * picked on the landing page (as billing.spec.ts, whose billing fake it reuses).
 */
test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ request }) => {
  const capabilities = await (await request.get("/api/auth/capabilities")).json();
  test.skip(
    !capabilities.emailCode,
    "the stack sends no mail, so sign-up opens a session: start it with DOZO_EMAIL_EMULATOR=1",
  );
});

const sessionOf = async (page: Page) =>
  (await (await page.request.get("/api/auth/get-session")).json()) as {
    user?: { email?: string; emailVerified?: boolean };
  } | null;

const signInCall = (page: Page, email: string, password: string) =>
  page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin: BASE },
  });

/** The password sign-up through the API: an unverified account, its verification mail sent. */
async function signUpCall(page: Page, email: string) {
  const answer = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name: "E2E Verify" },
    headers: { origin: BASE },
  });
  expect(answer.status()).toBe(200);
  expect(((await answer.json()) as { token: unknown }).token).toBeNull();
}

/** The Turkish sign-up form, filled and sent: it moves on to the code step, with no password asked. */
async function signUpForm(page: Page, email: string) {
  await page.goto("/sign-up?lang=tr");
  await expect(page.getByPlaceholder("Parola")).toHaveCount(0);
  await page.getByPlaceholder("Adınız").fill("E2E Verify");
  await page.getByPlaceholder("E-posta adresiniz").fill(email);
  await page.getByRole("button", { name: "Devam", exact: true }).click();
  await expect(page.getByRole("heading", { name: "E-postanızı kontrol edin" })).toBeVisible();
}

/** The Turkish sign-in form, filled and sent; the page stays where it is. */
async function signInForm(page: Page, email: string, password: string) {
  await emailFormTr(page, "/sign-in");
  await page.getByPlaceholder("E-posta adresiniz").fill(email);
  await page.getByPlaceholder("Parola").fill(password);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
}

test("parolalı hesap: giriş reddedilir ve yeni posta gelir; bağlantı + parola doğrular", async ({
  page,
  guard,
}) => {
  const email = uniqueEmail("mailbox");
  await signUpCall(page, email);
  expect(await sessionOf(page), "sign-up opened no session").toBeNull();
  // The sign-up's own mail.
  await expect
    .poll(async () => (await mailsTo(page.request, email)).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const sent = (await mailsTo(page.request, email)).length;

  // An unverified account is refused with the right password (the page sends a code instead; the
  // API call alone sends the link mail this test goes on with).
  expect((await signInCall(page, email, PASSWORD)).status()).toBe(403);
  expect(await sessionOf(page), "the refused sign-in opened no session").toBeNull();
  const link = await verificationLinkAfter(page.request, email, sent);

  // The mail's button in this browser, signed out: it verifies nothing yet and asks to sign in.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Devam etmek için oturum açın" })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email/);
  expect((await sessionOf(page))?.user?.emailVerified, "the link alone verified nothing").toBe(
    undefined,
  );
  await page.getByRole("link", { name: "Oturum aç", exact: true }).click();
  await page.waitForURL(/\/sign-in\/email$/);
  await expect(page.getByPlaceholder("E-posta adresiniz")).toHaveValue(email);
  await openPasswordFormTr(page);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  await page.waitForURL(/\/onboarding/);
  const session = await sessionOf(page);
  expect(session?.user?.email).toBe(email);
  expect(session?.user?.emailVerified).toBe(true);

  // The password stayed: a fresh browser state signs in with it.
  guard.allow(
    /401 POST [^ ]*\/rpc\//,
    "the open app reads once more after its cookies are cleared",
  );
  await page.context().clearCookies();
  expect((await signInCall(page, email, PASSWORD)).status()).toBe(200);
});

test("kayıt: ad ve e-posta, sonra kod; şifre sorulmaz ve hesap kodla açılır", async ({ page }) => {
  const passwordSignUps: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/sign-up/email")) passwordSignUps.push(request.url());
  });
  const email = uniqueEmail("signup");
  const before = (await mailsTo(page.request, email)).length;
  await signUpForm(page, email);
  expect(await sessionOf(page), "no session before the code").toBeNull();
  await page.getByLabel("Kod", { exact: true }).fill(await codeAfter(page.request, email, before));
  await page.waitForURL(/\/onboarding/);
  const session = await sessionOf(page);
  expect(session?.user?.email).toBe(email);
  expect(session?.user?.emailVerified).toBe(true);
  expect(passwordSignUps, "code sign-up never calls the password sign-up").toEqual([]);
});

test("doğrulanmamış hesabın parolayla girişi reddedilir ve kod adımına geçer", async ({
  page,
  guard,
}) => {
  guard.allow(
    /403 POST [^ ]*\/api\/auth\/sign-in\/email/,
    "an unverified account is refused with the right password: the point",
  );
  const email = uniqueEmail("unverified");
  await signUpCall(page, email);
  const before = (await mailsTo(page.request, email)).length;
  await signInForm(page, email, PASSWORD);
  await expect(page.getByRole("heading", { name: "E-postanızı kontrol edin" })).toBeVisible();
  await expect(page.getByText("E-posta doğrulaması gerekiyor")).toHaveCount(0);
  await page.getByLabel("Kod", { exact: true }).fill(await codeAfter(page.request, email, before));
  await page.waitForURL(/\/(app|onboarding)/);
  expect((await sessionOf(page))?.user?.emailVerified).toBe(true);
});

test("kodla giriş doğrular ama önceki parolayı siler", async ({ page, guard }) => {
  guard.allow(
    /401 POST [^ ]*\/api\/auth\/sign-in\/email/,
    "the password a code sign-in dropped is refused: the point",
  );
  const email = uniqueEmail("codeproof");
  const signUp = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name: "E2E Code Proof" },
    headers: { origin: BASE },
  });
  expect(signUp.status()).toBe(200);
  expect(((await signUp.json()) as { token: unknown }).token).toBeNull();
  // The sign-up's own verification mail is the one already there.
  const before = (await mailsTo(page.request, email)).length;

  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Use a password instead" })).toBeVisible();
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const mails = await mailsTo(page.request, email);
        code = mails.length > before ? codeIn(mails.at(-1)) : undefined;
        return code;
      },
      { timeout: 60_000 },
    )
    .toMatch(/^\d{6}$/);
  await page.getByLabel("Code", { exact: true }).fill(code as string);
  await page.waitForURL(/\/(app|onboarding)/);
  const session = await sessionOf(page);
  expect(session?.user?.email).toBe(email);
  expect(session?.user?.emailVerified).toBe(true);

  // Proving the mailbox takes away what was there before (upstream's guard against an address
  // someone else registered first): the password no longer signs in.
  guard.allow(
    /401 POST [^ ]*\/rpc\//,
    "the open app reads once more after its cookies are cleared",
  );
  await page.context().clearCookies();
  expect((await signInCall(page, email, PASSWORD)).status()).toBe(401);
});

test("numaralandırma yok: aynı ileti, aynı kontrol ekranı", async ({ page, guard }) => {
  guard.allow(
    /401 POST [^ ]*\/api\/auth\/sign-in\/email/,
    "a wrong password and an unknown address are refused: the point",
  );
  const email = uniqueEmail("known");
  // An address that already has an account and a new one meet the same code step, no session.
  await signUpCall(page, email);
  await signUpForm(page, email);
  const screen = async (address: string) =>
    ((await page.locator("body").textContent()) ?? "").replaceAll(address, "ADDRESS");
  const known = await screen(email);
  expect(await sessionOf(page)).toBeNull();
  await page.context().clearCookies();
  const fresh = uniqueEmail("fresh");
  await signUpForm(page, fresh);
  expect(await screen(fresh), "a new address shows the same screen as a known one").toBe(known);
  expect(await sessionOf(page)).toBeNull();

  // The API answers alike too: same status and the same set of keys (not values) in `user`.
  const shape = async (address: string) => {
    const answer = await page.request.post("/api/auth/sign-up/email", {
      data: { email: address, password: PASSWORD, name: "E2E Shape" },
      headers: { origin: BASE },
    });
    const body = (await answer.json()) as { token: unknown; user: Record<string, unknown> };
    return {
      status: answer.status(),
      body: Object.keys(body).sort(),
      token: body.token,
      user: Object.keys(body.user ?? {}).sort(),
    };
  };
  expect(await shape(email), "a repeated address answers like a new one").toEqual(
    await shape(uniqueEmail("shape")),
  );

  // Unknown address with some password, unverified address with a wrong one: one line.
  const wrong = "E-posta ya da parola yanlış";
  await signInForm(page, uniqueEmail("nobody"), PASSWORD);
  await expect(page.getByText(wrong)).toBeVisible();
  await signInForm(page, email, `${PASSWORD}-wrong`);
  await expect(page.getByText(wrong)).toBeVisible();
  await expect(page.getByText("E-posta doğrulaması gerekiyor")).toHaveCount(0);
});

test("kodla kayıt: seçilen plan ve kayıt başlangıcı kaybolmaz", async ({ page, browser }) => {
  const plans = await serverPlans(browser);
  const plus = plans.find((p) => p.tier === "max");
  expect(plus, "the server sells Premium Plus").toBeTruthy();
  const email = uniqueEmail("plan");
  await fakeBilling(page, plans);
  // The stack sends no product events on (no analytics provider): the app is told it does, and
  // what it reports is recorded here instead of sent.
  const events: { name?: string }[] = [];
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: Record<string, unknown> };
    if (body.json) Object.assign(body.json, { billingEnabled: true, productEvents: true });
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/dozoEvents/track", async (route) => {
    events.push((route.request().postDataJSON() as { json?: { name?: string } }).json ?? {});
    await route.fulfill({ json: { json: null } });
  });

  // The landing page's Premium Plus card, yearly, leads to sign-up; the code makes the account.
  await page.goto("/sign-up?plan=premium_plus&period=year");
  await expect(page).not.toHaveURL(/plan=/);
  const before = (await mailsTo(page.request, email)).length;
  await page.getByPlaceholder("Your name").fill("E2E Plan");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(await codeAfter(page.request, email, before));
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Later" }).click();
  await page.waitForURL(/\/app/);

  // Soft, so a run without the start still says whether the plan came through.
  await expect
    .configure({ soft: true })
    .poll(() => events.map((event) => event.name), { message: "the sign-up start was reported" })
    .toContain("signup_started");
  await expect(page, "Billing opened with the plan picked before sign-up").toHaveURL(
    /settings=billing/,
  );
  const subscribe = page
    .getByTestId("user-settings")
    .getByRole("button", { name: /^Subscribe for/ });
  await expect(subscribe).toContainText(`${dollars(plus?.annualPriceCents ?? null)} / year`);
});
