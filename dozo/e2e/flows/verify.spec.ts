import type { Page } from "@playwright/test";
import { PASSWORD } from "../support";
import { BASE } from "./accounts";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * The verification link, end to end, in Turkish. The stack sends no mail, so run.sh makes the
 * links a mail would carry (a valid and an expired one, for an address only this run uses) with
 * the api's own secret; the link is opened as the mail's button opens it, through the server's
 * verify endpoint, which lands on the result page with the address (and an error code when it did
 * not verify), as `verificationCallbackUrl` in packages/auth sets it.
 */
test.use({ storageState: SIGNED_OUT });

const EMAIL = process.env.DOZO_E2E_VERIFY_EMAIL ?? "";
const VALID = process.env.DOZO_E2E_VERIFY_TOKEN ?? "";
const EXPIRED = process.env.DOZO_E2E_VERIFY_EXPIRED ?? "";

function link(token: string) {
  const back = `${BASE}/verify-email?email=${encodeURIComponent(EMAIL)}`;
  return `/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent(back)}`;
}

/** The stack sends no mail; the page is told it does, so the parts that need mail show. */
async function serverSendsMail(page: Page) {
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), emailCode: true } });
  });
}

test("doğrulama bağlantısı: kayıt, hatırlatma, doğrulandı, ikinci tıklama", async ({
  page,
  guard,
}) => {
  expect(EMAIL && VALID && EXPIRED, "run.sh makes the verification links").toBeTruthy();
  guard.allow(
    /404 POST [^ ]*\/rpc\/billing\/status/,
    "FINDING: the model step asks for the billing status on a server without billing, which answers 404",
  );
  await serverSendsMail(page);
  await page.goto("/sign-up?lang=tr");
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  await expect(page.getByPlaceholder("E-posta adresiniz").or(choice).first()).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("Adınız").fill("E2E Verify");
  await page.getByPlaceholder("E-posta adresiniz").fill(EMAIL);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
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
  await mail.goto(link(VALID));
  await expect(mail.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await expect(mail).toHaveURL(/\/verify-email$/);
  // A previewer or a second click opened it first: still a success, never an error.
  await mail.goto(link(VALID));
  await expect(mail.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await mail.getByRole("link", { name: "Devam" }).click();
  await mail.waitForURL(/\/app/);
  await mail.close();

  // Back in the app tab, the session is read again and the line is gone.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reminder).toBeHidden();

  // Signed out, the same link says so and offers sign-in with the address filled in.
  guard.allow(
    /401 POST [^ ]*\/rpc\//,
    "the open app reads once more after its cookies are cleared, before the link is opened",
  );
  await page.context().clearCookies();
  await page.goto(link(VALID));
  await expect(page.getByRole("heading", { name: "E-posta adresiniz doğrulandı" })).toBeVisible();
  await page.getByRole("link", { name: "Devam" }).click();
  await page.waitForURL(/\/sign-in\/email$/);
  await expect(page.getByPlaceholder("E-posta adresiniz")).toHaveValue(EMAIL);
});

test("süresi dolmuş ve geçersiz bağlantı: kısa ileti, yeni bağlantı isteği", async ({
  page,
  guard,
}) => {
  guard.allow(
    /400 POST [^ ]*\/api\/auth\/send-verification-email/,
    "the stack has no mail provider, so the server refuses to send; the request itself is the point",
  );
  await serverSendsMail(page);
  // The language a link asks for is saved once sign-in shows it; the result page then reads it.
  await page.goto("/sign-in?lang=tr");
  await expect(page.getByRole("heading", { name: "Dozo'da oturum açın" })).toBeVisible();
  await page.goto(link(EXPIRED));
  await expect(page.getByRole("heading", { name: "Bağlantının süresi dolmuş" })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByPlaceholder("E-posta adresiniz")).toHaveValue(EMAIL);
  const asked = page.waitForRequest("**/api/auth/send-verification-email");
  await page.getByRole("button", { name: "Yeni bağlantı gönder" }).click();
  expect((await asked).postDataJSON()).toMatchObject({ email: EMAIL });
  await expect(page.getByRole("alert")).toHaveText("Bağlantı gönderilemedi");

  // A link the server cannot read.
  await page.goto(link("e2e-not-a-token"));
  await expect(
    page.getByRole("heading", { name: "Bu bağlantı artık geçerli değil" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Oturum aç" })).toBeVisible();
});
