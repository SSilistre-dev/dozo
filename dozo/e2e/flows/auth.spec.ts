import { PASSWORD } from "../support";
import { BASE, uniqueEmail } from "./accounts";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * Sign-up, sign-in, sign-out and their refusals, through the real forms, in Turkish (the
 * fork's main language: the error lines are the fork's own translations). Each test starts signed out.
 */
test.use({ storageState: SIGNED_OUT });

async function emailForm(page: import("@playwright/test").Page, path: string) {
  await page.goto(`${path}?lang=tr`);
  // Sign-in by emailed code offers the password one step away; sign-up and a server without codes
  // show the form, or a choice of providers first.
  const password = page.getByRole("button", { name: "Bunun yerine şifre kullan" });
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  const field = page.getByPlaceholder("Parola");
  await expect(password.or(choice).or(field).first()).toBeVisible();
  if (await password.isVisible()) await password.click();
  else if (await choice.isVisible()) await choice.click();
  await expect(field).toBeVisible();
}

test("kayıt, çıkış, yeniden giriş", async ({ page }) => {
  const email = uniqueEmail("auth");
  await emailForm(page, "/sign-up");
  await expect(page.getByRole("heading", { name: "Hesabınızı oluşturun" })).toBeVisible();
  await page.getByPlaceholder("Adınız").fill("E2E Auth");
  await page.getByPlaceholder("E-posta adresiniz").fill(email);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await page.waitForURL(/\/onboarding/);
  // Signing out from the model step's account menu is not offered: sign out through the app.
  await page.getByRole("button", { name: "Daha sonra" }).click();
  await page.waitForURL(/\/app\/[^/?]+/);
  await page.getByRole("button", { name: /hesap menüsü/ }).click();
  await page.getByText("Çıkış yap", { exact: true }).click();
  await page.waitForURL(/\/sign-in/);
  await expect(page.getByRole("heading", { name: "Dozo'da oturum açın" })).toBeVisible();
  await emailForm(page, "/sign-in");
  await page.getByPlaceholder("E-posta adresiniz").fill(email);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
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

test("var olan e-postayla kayıt: Türkçe hata", async ({ page, guard }) => {
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
  await emailForm(page, "/sign-up");
  await page.getByPlaceholder("Adınız").fill("E2E Twice");
  await page.getByPlaceholder("E-posta adresiniz").fill(email);
  await page.getByPlaceholder("Parola").fill(PASSWORD);
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(page.getByText("Bu e-postayla bir hesap zaten var")).toBeVisible();
});

test("parola sıfırlama: bağlantı isteği ve geçersiz bağlantı", async ({ page }) => {
  await page.goto("/forgot-password?lang=tr");
  await page.getByPlaceholder("E-posta adresiniz").fill(uniqueEmail("reset"));
  await page.getByRole("button", { name: "Sıfırlama bağlantısı gönder" }).click();
  // This stack sends no mail: the page says so instead of pretending a link went out.
  await expect(page.getByText("Bu sunucu için parola kurtarma yapılandırılmamış")).toBeVisible();
  await page.goto("/reset-password?token=e2e-not-a-token&lang=tr");
  await expect(page.getByRole("button", { name: "Parolayı sıfırla" })).toBeVisible();
});
