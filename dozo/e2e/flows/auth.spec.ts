import { codeAfter, mailsTo, PASSWORD } from "../support";
import { BASE, emailFormTr as emailForm, openPasswordFormTr, uniqueEmail } from "./accounts";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * Sign-up, sign-in, sign-out and their refusals, through the real forms, in Turkish (the
 * fork's main language: the error lines are the fork's own translations). Each test starts signed out.
 */
test.use({ storageState: SIGNED_OUT });

test("kayıt, çıkış, yeniden giriş", async ({ page }) => {
  const email = uniqueEmail("auth");
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  await page.goto("/sign-up?lang=tr");
  await expect(page.getByRole("heading", { name: "Hesabınızı oluşturun" })).toBeVisible();
  if (capabilities.emailCode) {
    // A server with mail signs up with a name, an address and a code, and no password.
    const before = (await mailsTo(page.request, email)).length;
    await page.getByPlaceholder("Adınız").fill("E2E Auth");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByRole("button", { name: "Devam", exact: true }).click();
    await expect(page.getByRole("heading", { name: "E-postanızı kontrol edin" })).toBeVisible();
    await page
      .getByLabel("Kod", { exact: true })
      .fill(await codeAfter(page.request, email, before));
  } else {
    await openPasswordFormTr(page);
    await page.getByPlaceholder("Adınız").fill("E2E Auth");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByPlaceholder("Parola").fill(PASSWORD);
    await page.getByRole("button", { name: "Hesap oluştur" }).click();
  }
  await page.waitForURL(/\/onboarding/);
  // Signing out from the model step's account menu is not offered: sign out through the app.
  await page.getByRole("button", { name: "Daha sonra" }).click();
  await page.waitForURL(/\/app\/[^/?]+/);
  await page.getByRole("button", { name: /hesap menüsü/ }).click();
  await page.getByText("Çıkış yap", { exact: true }).click();
  await page.waitForURL(/\/sign-in/);
  await expect(page.getByRole("heading", { name: "Dozo'da oturum açın" })).toBeVisible();
  if (capabilities.emailCode) {
    // The account has no password: it signs in with a new code.
    const before = (await mailsTo(page.request, email)).length;
    await page.goto("/sign-in?lang=tr");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByRole("button", { name: "Devam", exact: true }).click();
    await page
      .getByLabel("Kod", { exact: true })
      .fill(await codeAfter(page.request, email, before));
  } else {
    await emailForm(page, "/sign-in");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByPlaceholder("Parola").fill(PASSWORD);
    await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  }
  await page.waitForURL(/\/app\/[^/?]+/);
  await expect(page.getByRole("button", { name: "Uygulamaları bağla" })).toBeVisible();
});

test("yanlış parola: Türkçe hata", async ({ page, guard }) => {
  guard.allow(/401 POST [^ ]*\/api\/auth\/sign-in\/email/, "the wrong password is the point");
  await emailForm(page, "/sign-in");
  await page.getByPlaceholder("E-posta adresiniz").fill(uniqueEmail("nobody"));
  await page.getByPlaceholder("Parola").fill(`${PASSWORD}-wrong`);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  await expect(page.getByText("E-posta ya da parola yanlış")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("var olan e-postayla kayıt: Türkçe hata (posta varsa aynı kod ekranı)", async ({
  page,
  guard,
}) => {
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  // A server with mail answers a repeated sign-up like a first one (the same code step, nothing to
  // tell an address from a new one); a server without mail still says the address is taken.
  if (!capabilities.emailCode)
    guard.allow(
      /422 POST [^ ]*\/api\/auth\/sign-up\/email/,
      "the second sign-up is refused on purpose",
    );
  const email = uniqueEmail("twice");
  const first = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name: "E2E Twice" },
    headers: { origin: BASE },
  });
  expect(first.status()).toBe(200);
  await page.context().clearCookies();
  await page.goto("/sign-up?lang=tr");
  if (capabilities.emailCode) {
    await page.getByPlaceholder("Adınız").fill("E2E Twice");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByRole("button", { name: "Devam", exact: true }).click();
    await expect(page.getByRole("heading", { name: "E-postanızı kontrol edin" })).toBeVisible();
    const session = await (await page.request.get("/api/auth/get-session")).json();
    expect(session, "the second sign-up opened no session").toBeNull();
  } else {
    await openPasswordFormTr(page);
    await page.getByPlaceholder("Adınız").fill("E2E Twice");
    await page.getByPlaceholder("E-posta adresiniz").fill(email);
    await page.getByPlaceholder("Parola").fill(PASSWORD);
    await page.getByRole("button", { name: "Hesap oluştur" }).click();
    await expect(page.getByText("Bu e-postayla bir hesap zaten var")).toBeVisible();
  }
});

test("parola sıfırlama: bağlantı isteği ve geçersiz bağlantı", async ({ page }) => {
  await page.goto("/forgot-password?lang=tr");
  await page.getByPlaceholder("E-posta adresiniz").fill(uniqueEmail("reset"));
  await page.getByRole("button", { name: "Sıfırlama bağlantısı gönder" }).click();
  // A stack that sends no mail says so instead of pretending a link went out; one with the email
  // emulator (DOZO_EMAIL_EMULATOR=1) sends it.
  const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
  await expect(
    capabilities.passwordReset
      ? page.getByRole("heading", { name: "E-postanızı kontrol edin" })
      : page.getByText("Bu sunucu için parola kurtarma yapılandırılmamış"),
  ).toBeVisible();
  await page.goto("/reset-password?token=e2e-not-a-token&lang=tr");
  await expect(page.getByRole("button", { name: "Parolayı sıfırla" })).toBeVisible();
});
