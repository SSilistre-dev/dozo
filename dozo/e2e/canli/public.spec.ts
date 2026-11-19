import { cachedForGood } from "./budgets";
import {
  expect,
  firstContent,
  measure,
  note,
  openAndSee,
  placeholderLinks,
  SIGNED_OUT,
  test,
} from "./live";

/** Screens anyone sees, without an account. */
test.use({ storageState: SIGNED_OUT });

test("soğuk açılış: /sign-in ilk içerik", async ({ page }) => {
  await openAndSee(page, "/sign-in?lang=tr", (shown) =>
    shown.getByRole("heading", { name: "Dozo'da oturum açın" }),
  );
  const fcp = await firstContent(page);
  expect(fcp, "first contentful paint").not.toBeNull();
  measure("coldFirstContent", fcp as number);
});

test("yanlış parola: Türkçe hata iletisi", async ({ page, guard }) => {
  guard.allow(/401 POST [^ ]*\/api\/auth\/sign-in\/email/, "the wrong password is the point");
  await page.goto("/sign-in?lang=tr");
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  if (await choice.isVisible()) await choice.click();
  const id = Math.random().toString(36).slice(2, 10);
  await page.getByPlaceholder("E-posta adresiniz").fill(`info+dozo-probe-yok${id}@ssilistre.dev`);
  await page.getByPlaceholder("Parola").fill(`yanlis-${id}`);
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  await expect(page.getByText("E-posta ya da parola yanlış")).toBeVisible();
});

test("parola sıfırlama formu Türkçe açılır", async ({ page }) => {
  await page.goto("/forgot-password?lang=tr");
  await expect(page.getByRole("button", { name: "Sıfırlama bağlantısı gönder" })).toBeVisible();
});

test("bilinmeyen adres: 404 sayfası", async ({ page }) => {
  await page.goto(`/bu-sayfa-yok-${Math.random().toString(36).slice(2, 8)}?lang=tr`);
  await expect(page.getByText("Sayfa bulunamadı")).toBeVisible();
});

test("ölü bağlantı taraması: giriş, kayıt, parola sıfırlama", async ({ page, request }) => {
  const own = new URL(process.env.CANLI_URL as string);
  const site = own.hostname.split(".").slice(-2).join(".");
  const links = new Set<string>();
  for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/not-a-page-e2e"]) {
    // The page has drawn its heading (the links come with the form).
    await openAndSee(page, `${path}?lang=tr`, (shown) => shown.getByRole("heading").first());
    expect(await placeholderLinks(page), `placeholder links on ${path}`).toEqual([]);
    for (const href of await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
    ))
      links.add(href.split("#")[0] as string);
  }
  // Our own pages (this site and its sibling sites) must answer; a third party's are only listed.
  const ours = [...links].filter((href) => {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) && url.hostname.endsWith(site);
  });
  const dead: string[] = [];
  for (const href of ours) {
    const answer = await request.get(href, { maxRedirects: 5, failOnStatusCode: false });
    if (answer.status() >= 400) dead.push(`${answer.status()} ${href}`);
  }
  expect(dead, "own links that do not answer").toEqual([]);
  note(
    `${ours.length} kendi bağlantısı denendi, ${links.size - ours.length} dış bağlantı listelendi`,
  );
});

test("/assets önbellek başlıkları: kalıcı ve değişmez", async ({ page }) => {
  const assets = new Map<string, string | null>();
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/assets/") && response.status() === 200)
      assets.set(url.pathname, (await response.allHeaders())["cache-control"] ?? null);
  });
  await page.goto("/sign-in?lang=tr");
  await expect(page.getByRole("heading", { name: "Dozo'da oturum açın" })).toBeVisible();
  await expect.poll(() => assets.size).toBeGreaterThan(0);
  const wrong = [...assets].filter(([, header]) => !cachedForGood(header));
  expect(
    wrong.map(([path, header]) => `${path}: ${header}`),
    "assets not cached for good",
  ).toEqual([]);
  // The page itself must not be cached for good, or a deploy would never reach a returning visitor.
  const document = await page.request.get("/sign-in");
  expect(cachedForGood(document.headers()["cache-control"]), "the HTML is cached for good").toBe(
    false,
  );
  note(`${assets.size} dosya: public, max-age ≥ 1 yıl, immutable`);
});
