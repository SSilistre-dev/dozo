import { expect, SIGNED_OUT, test } from "./live";

/**
 * The optional admin mode: only when DOZO_CANLI_ADMIN_EMAIL and DOZO_CANLI_ADMIN_PASSWORD are in
 * the environment. It signs in and opens every admin section READ ONLY: the fence in live.ts
 * refuses any changing admin call, and no action button is pressed. The pages list real members,
 * so no picture is kept and nothing they show is written to the report.
 */
const email = process.env.DOZO_CANLI_ADMIN_EMAIL;
const password = process.env.DOZO_CANLI_ADMIN_PASSWORD;

test.use({ storageState: SIGNED_OUT });
test.skip(!email || !password, "admin mode is off (DOZO_CANLI_ADMIN_EMAIL/_PASSWORD not set)");

const SECTIONS: [path: string, label: string][] = [
  ["/admin", "Üyeler"],
  ["/admin/access", "Ücretsiz erişim"],
  ["/admin/plugins", "Eklentiler"],
  ["/admin/settings", "Site ayarları"],
  ["/admin/plans", "Planlar"],
  ["/admin/billing", "Faturalandırma"],
  ["/admin/funnel", "Huni"],
];

test("admin bölümleri salt okunur açılır", async ({ page }) => {
  await page.goto("/sign-in?lang=tr");
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("E-posta adresiniz").fill(email as string);
  await page.getByPlaceholder("Parola").fill(password as string);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  await page.waitForURL(/\/(app|onboarding)/, { timeout: 45_000 });
  for (const [path, label] of SECTIONS) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "Yönetim" });
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByTestId("page-loading")).toHaveCount(0);
    await expect(page.getByText(/yüklenemedi|Couldn't load/i)).toHaveCount(0);
  }
  // The pages show real members: leave a neutral screen for the closing picture.
  await page.goto("/admin/plans");
  await expect(page.getByRole("navigation", { name: "Yönetim" })).toBeVisible();
});
