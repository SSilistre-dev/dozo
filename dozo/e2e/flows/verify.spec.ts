import type { Page } from "@playwright/test";
import { openPasswordFormTr } from "./accounts";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * The verification link, end to end, in Turkish. run.sh signs up an account for this run and makes
 * the links its mail would carry (a valid and an expired one) with the api's own secret: through
 * the server's verify endpoint, back to the result page with the signed mark and, when the link
 * did not verify, an error code.
 *
 * Two kinds of stack. Without a mail provider the account signs up with a session, the server
 * refuses to send a new link, and the second scenario (a signed-in, unverified account and its
 * reminder) runs. With the email emulator (DOZO_EMAIL_EMULATOR=1) the server sends and a
 * password sign-in of an unverified account is refused, so that account cannot be signed in with
 * its password: the second scenario is skipped there, and signup-verification.spec.ts walks the
 * mailbox-first flow for it instead.
 */
test.use({ storageState: SIGNED_OUT });

const EMAIL = process.env.DOZO_E2E_VERIFY_EMAIL ?? "";
const PASSWORD = process.env.DOZO_E2E_VERIFY_PASSWORD ?? "";
const LINK = process.env.DOZO_E2E_VERIFY_LINK ?? "";
const EXPIRED = process.env.DOZO_E2E_VERIFY_EXPIRED ?? "";

async function stackSendsMail(page: Page) {
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  return capabilities.emailCode === true;
}

/** The stack sends no mail; the page is told it does, so the parts that need mail show. */
async function serverSendsMail(page: Page) {
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), emailCode: true } });
  });
}

/** Sign-in in Turkish; the language a link asks for is saved once the page shows it. */
async function signInPage(page: Page) {
  await page.goto("/sign-in?lang=tr");
  await expect(page.getByRole("heading", { name: "Dozo'da oturum açın" })).toBeVisible();
}

test("süresi dolmuş bağlantı: kısa ileti, yeni bağlantı isteği; okunamayan bağlantı", async ({
  page,
  guard,
}) => {
  expect(EMAIL && PASSWORD && LINK && EXPIRED, "run.sh makes the verification links").toBeTruthy();
  const sends = await stackSendsMail(page);
  if (!sends)
    guard.allow(
      /400 POST [^ ]*\/api\/auth\/send-verification-email/,
      "the stack has no mail provider, so the server refuses to send; the request itself is the point",
    );
  await serverSendsMail(page);
  await signInPage(page);
  await page.goto(EXPIRED);
  await expect(page.getByRole("heading", { name: "Bağlantının süresi dolmuş" })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  // The address comes from the server, for the account the link's mark names; no URL carries it.
  await expect(page.getByPlaceholder("E-posta adresiniz")).toHaveValue(EMAIL);
  const asked = page.waitForRequest("**/api/auth/send-verification-email");
  await page.getByRole("button", { name: "Yeni bağlantı gönder" }).click();
  expect((await asked).postDataJSON()).toMatchObject({ email: EMAIL });
  // With a provider the new link goes out and the page says to whom; without one the server
  // refuses and the page says it could not.
  if (sends) await expect(page.getByRole("status")).toContainText("yeni bir bağlantı gönderdik");
  else await expect(page.getByRole("alert")).toHaveText("Bağlantı gönderilemedi");

  // A link the server cannot read.
  await page.goto(LINK.replace(/token=[^&]+/, "token=e2e-not-a-token"));
  await expect(
    page.getByRole("heading", { name: "Bu bağlantı artık geçerli değil" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Oturum aç" })).toBeVisible();

  // A hand-made result address claims nothing.
  await page.goto("/verify-email?v=e2e-forged");
  await expect(page.getByRole("heading", { name: "Devam etmek için oturum açın" })).toBeVisible();
});

test("doğrulama bağlantısı: hatırlatma, doğrulandı, ikinci tıklama, oturumsuz", async ({
  page,
  guard,
}) => {
  test.skip(
    await stackSendsMail(page),
    "with a mail provider an unverified account cannot sign in with its password (the mailbox comes first), so this account has no session to show the reminder in; signup-verification.spec.ts covers that stack",
  );
  guard.allow(
    /404 POST [^ ]*\/rpc\/billing\/status/,
    "FINDING: the model step asks for the billing status on a server without billing, which answers 404",
  );
  await serverSendsMail(page);
  await signInPage(page);
  // A server that sends mail starts sign-in with the emailed code; the password is one step away.
  await openPasswordFormTr(page);
  await page.getByPlaceholder("E-posta adresiniz").fill(EMAIL);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Daha sonra" }).click();
  await page.waitForURL(/\/app\/[^/?]+/);
  // Verification stays optional: the app is open, with one line asking for it.
  const reminder = page.getByRole("status").filter({ hasText: "E-postanızı doğrulayın" });
  await expect(reminder).toBeVisible();
  await expect(reminder.getByRole("button", { name: "Yeniden gönder" })).toBeVisible();

  // The mail's button, in another tab of the same browser.
  const mail = await page.context().newPage();
  guard.follow(mail);
  await mail.goto(LINK);
  await expect(mail.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await expect(mail).toHaveURL(/\/verify-email$/);
  // A previewer or a second click opened it first: still a success, never an error.
  await mail.goto(LINK);
  await expect(mail.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await mail.getByRole("link", { name: "Devam" }).click();
  await mail.waitForURL(/\/app/);
  await mail.close();

  // Back in the app tab, the session is read again and the line is gone.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reminder).toBeHidden();

  // Signed out, the same link still says verified, from the server's word for the marked account,
  // and sign-in opens with the address filled in.
  guard.allow(
    /401 POST [^ ]*\/rpc\//,
    "the open app reads once more after its cookies are cleared, before the link is opened",
  );
  await page.context().clearCookies();
  await page.goto(LINK);
  await expect(page.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await page.getByRole("link", { name: "Oturum aç" }).click();
  await page.waitForURL(/\/sign-in\/email$/);
  await expect(page.getByPlaceholder("E-posta adresiniz")).toHaveValue(EMAIL);
});
