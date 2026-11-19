import { rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { outDir } from "../scan";
import type { Probe } from "./live";
import {
  deleteProbe,
  expect,
  firstContent,
  measure,
  newProbe,
  note,
  openAndSee,
  placeholderLinks,
  readProbe,
  STATE_FILE,
  saveProbe,
  test,
} from "./live";

/**
 * The live run's own account, in file order (one worker): sign up, walk read-only screens of that
 * account, delete it. A failed step does not skip the others. Whatever fails, the run's global
 * teardown (canli/cleanup.ts) deletes the account if it is still there: the finally step.
 */

const SIGN_UP = "kayıt → model adımı → 'Daha sonra' → uygulama";

// Every later step needs the account: without it they report the one root cause, not their own.
// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a hook's first parameter as an object pattern
test.beforeEach(({}, info) => {
  if (info.title !== SIGN_UP && !readProbe()) test.skip(true, "atlandı: hesap açılamadı");
});

/** The page's language is Turkish from the first screen: the run reads Turkish copy. */
async function openApp(page: Page, path = "/app") {
  await openAndSee(page, "/app", (shown) =>
    shown.getByRole("button", { name: "Uygulamaları bağla" }),
  );
  if (path !== "/app") await page.goto(path);
}

test(SIGN_UP, async ({ page, guard }) => {
  guard.allow(
    /404 POST [^ ]*\/rpc\/billing\/status/,
    "a server without billing answers 404 (local runs)",
  );
  const probe = newProbe();
  await page.goto("/sign-up?lang=tr");
  await expect(page.getByRole("heading", { name: "Hesabınızı oluşturun" })).toBeVisible();
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("Adınız").fill("Dozo Probe");
  await page.getByPlaceholder("E-posta adresiniz").fill(probe.email);
  await page.getByPlaceholder("Parola").fill(probe.password);
  const signUp = page.waitForResponse((r) => r.url().includes("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  const answer = await signUp;
  expect(answer.status(), "sign-up answer").toBe(200);
  // From here on the account exists: the global teardown deletes it whatever happens next.
  saveProbe(probe);
  await page.waitForURL(/\/onboarding/, { timeout: 45_000 });
  // A server that asks the survey first (the live one does): answer the one required question.
  const model = page.getByRole("heading", { name: "Model bağla" });
  const survey = page.getByRole("heading", { name: "Dozo'ya hoş geldiniz" });
  await expect(model.or(survey)).toBeVisible();
  if (await survey.isVisible()) {
    await page
      .getByRole("radio", { name: "Kişisel" })
      .or(page.getByText("Kişisel", { exact: true }))
      .first()
      .click();
    await page.getByRole("button", { name: "Devam", exact: true }).click();
  }
  await expect(model).toBeVisible();
  await page.getByRole("button", { name: "Daha sonra" }).click();
  await page.waitForURL(/\/app\/[^/?]+/, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Uygulamaları bağla" })).toBeVisible();
  await page.context().storageState({ path: STATE_FILE() });
});

test("aynı e-postayla ikinci kayıt Türkçe hata verir", async ({ browser }) => {
  const probe = readProbe() as Probe;
  // A signed-out browser of its own; its 422 is the answer under test, so it is not watched.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-up?lang=tr");
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  if (await choice.isVisible()) await choice.click();
  await page.getByPlaceholder("Adınız").fill("Dozo Probe");
  await page.getByPlaceholder("E-posta adresiniz").fill(probe.email);
  await page.getByPlaceholder("Parola").fill(probe.password);
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(page.getByText("Bu e-postayla bir hesap zaten var")).toBeVisible();
  await page.screenshot({ path: `${outDir()}/shots/canli--ikinci-kayit.png` });
  await context.close();
});

test("soğuk açılış: /app ilk içerik", async ({ page }) => {
  // A new context per test: the HTTP cache is cold.
  await openApp(page);
  const fcp = await firstContent(page);
  if (fcp !== null) measure("coldAppFirstContent", fcp);
});

test("Uygulamalar penceresi açılır, logolar kendi adresimizden yüklenir", async ({ page }) => {
  await openApp(page);
  const started = Date.now();
  await page.getByRole("button", { name: "Uygulamaları bağla" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  measure("appsDialog", Date.now() - started);
  await expect(dialog.getByRole("button", { name: "Ekle" }).first()).toBeVisible();
  measure("appsFirstTile", Date.now() - started);
  const logos = dialog.locator("img");
  await expect(logos.first()).toBeVisible();
  // Every logo drawn (not a broken image) and served by the app itself, not a third party.
  await expect
    .poll(() =>
      logos.evaluateAll(
        (all) =>
          // The tiles in view; the rest load lazily as the list scrolls.
          all.filter((img) => {
            const box = img.getBoundingClientRect();
            const shown = box.bottom > 0 && box.top < window.innerHeight;
            return shown && !(img as HTMLImageElement).complete;
          }).length,
      ),
    )
    .toBe(0);
  const logoState = await logos.evaluateAll((all) =>
    all.map((img) => {
      const box = img.getBoundingClientRect();
      return {
        src: (img as HTMLImageElement).src,
        width: (img as HTMLImageElement).naturalWidth,
        shown: box.bottom > 0 && box.top < window.innerHeight,
      };
    }),
  );
  const origin = new URL(page.url()).origin;
  const broken = logoState.filter((logo) => logo.shown && logo.width === 0).map((logo) => logo.src);
  const foreign = logoState.filter((logo) => !logo.src.startsWith(origin)).map((logo) => logo.src);
  expect(broken, "logos that did not load").toEqual([]);
  expect(foreign, "logos served from another host").toEqual([]);
  note(
    `${logoState.length} logo (${logoState.filter((l) => l.shown).length} görünür, hepsi yüklendi), hepsi ${origin} üzerinden`,
  );
  expect(await placeholderLinks(page), "placeholder links in the Apps dialog").toEqual([]);
});

test("Ayarlar → Modeller açılır (katalog yanıtları sayılır)", async ({ page }) => {
  await openApp(page, "/app?settings=general");
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const answers: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/rpc/") && !/subscribe|analytics|computer\/updates/.test(path))
      answers.push(path);
  });
  await settings.getByRole("button", { name: "Modeller", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Modeller" })).toBeVisible();
  await expect(settings.getByText("Ana model")).toBeVisible();
  // Settled: the count holds still for a second.
  let last = -1;
  await expect
    .poll(
      () => {
        const same = answers.length === last;
        last = answers.length;
        return same;
      },
      { intervals: [1_000], timeout: 15_000 },
    )
    .toBe(true);
  // The catalog: the model answers the section asks for (the rest are the settings shell's own).
  measure("modelsResponses", answers.filter((path) => path.startsWith("/rpc/models/")).length);
  note(`Modeller: ${answers.map((a) => a.replace("/rpc/", "")).join(", ")}`);
  expect(await placeholderLinks(page), "placeholder links in Settings").toEqual([]);
});

/** Whether the server sells plans; a server without billing has no Billing section. */
async function billingOn(page: Page) {
  const me = await page.request.post("/rpc/me", { data: { json: null } });
  const body = (await me.json()) as { json?: { billingEnabled?: boolean } };
  return body.json?.billingEnabled === true;
}

test("Faturalandırma ekranı ve ödemeden dönüş (?billing=canceled)", async ({ page }) => {
  await openApp(page);
  test.skip(!(await billingOn(page)), "this server does not bill");
  await page.goto("/app?billing=canceled");
  await expect(page).toHaveURL(/settings=billing/);
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Faturalandırma" })).toBeVisible();
  await expect(settings.getByText("Premium", { exact: true }).first()).toBeVisible();
  await expect(page).not.toHaveURL(/billing=canceled/);
});

test("ödeme sayfası açılır, doğru plan ve tutar (kart girilmez)", async ({ page, guard }) => {
  await openApp(page);
  test.skip(!(await billingOn(page)), "this server does not bill");
  const status = page.waitForResponse((r) => r.url().includes("/rpc/billing/status"));
  await page.goto("/app?settings=billing");
  const tiers = (
    (await (await status).json()) as {
      json: { byokTiers?: { tier: string; name: string; monthlyPriceCents: number }[] };
    }
  ).json.byokTiers;
  const premium = tiers?.find((tier) => tier.tier === "pro");
  expect(premium, "the server offers Premium").toBeTruthy();
  const settings = page.getByTestId("user-settings");
  // Premium and monthly are what the screen starts on.
  const subscribe = settings.getByRole("button", { name: /^Aylık .* ile abone ol$/ });
  await expect(subscribe).toBeVisible();
  const amount = ((premium?.monthlyPriceCents ?? 0) / 100).toFixed(0);
  await expect(subscribe).toContainText(amount);
  const app = new URL(page.url()).origin;
  guard.leaveApp();
  await subscribe.click();
  await page.waitForURL((url) => url.origin !== app, { timeout: 45_000 });
  const host = new URL(page.url()).host;
  // Stripe shows the plan's product name and the amount with two decimals, in either separator.
  await expect(page.getByText(new RegExp(`${amount}[.,]00`)).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(new RegExp(premium?.name as string)).first()).toBeVisible();
  note(`ödeme sayfası ${host}: ${premium?.name}, ${amount},00 (kart girilmedi)`);
});

test("Free: bilgisayar uyandırma reddedilir, Türkçe ileti ve Yükselt", async ({ page, guard }) => {
  guard.allow(
    /403 POST [^ ]*\/rpc\/computer\/boot/,
    "Free has no computer: the refusal is the point",
  );
  await openApp(page);
  test.skip(!(await billingOn(page)), "this server does not bill, so Free has no limit");
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByText("Planınızda bilgisayar yok.").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Yükselt" }).first()).toBeVisible();
});

test("hesap silinir ve silindiği doğrulanır", async ({ page }) => {
  const probe = readProbe() as Probe;
  const seen = await deleteProbe(page.request, probe);
  saveProbe({ ...probe, deleted: true });
  rmSync(STATE_FILE(), { force: true });
  note(`${probe.email.replace(/\+.*@/, "+…@")}: ${seen}`);
});
