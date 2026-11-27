import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { outDir } from "../scan";
import type { TrialAccount } from "./account-file";
import { loadAccount, missingReason } from "./account-file";
import {
  expect,
  firstContent,
  measure,
  note,
  openAndSee,
  openPasswordForm,
  placeholderLinks,
  STATE_FILE,
  test,
} from "./live";

/**
 * The live run's standing trial account, in file order (one worker). The server asks for the
 * mailbox before a password sign-in and a run cannot read a mailbox on the live site, so the run
 * does not open an account: its owner opens one trial account once, verifies it, and keeps its
 * address and password in a file outside the repository (canli/account-file.ts, `canli.sh`). With
 * no file every scenario here skips, saying where the file goes; a broken file fails them.
 *
 * The run no longer deletes an account or tries to: the trial account is permanent. No scenario
 * changes its data (no name, password, setting or plan), and signing in again each run only ends in
 * a session the run's own teardown forgets (canli/cleanup.ts).
 */

const SIGN_IN = "giriş → (ilk koşuda anket ve model adımları) → uygulama";
const SIGN_UP_ASKS = "kayıt önce kod ister (hesap açmaz, posta yollamaz)";

function trialAccount(): TrialAccount | null {
  const state = loadAccount(process.env);
  return state.kind === "ok" ? state.account : null;
}

// Every step needs the file; the steps after the sign-in need its session too, so a failed sign-in
// reports its own cause once and the rest say they were not reached.
// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a hook's first parameter as an object pattern
test.beforeEach(({}, info) => {
  const state = loadAccount(process.env);
  if (state.kind === "none") test.skip(true, missingReason(state.hostPath));
  if (info.title !== SIGN_IN && info.title !== SIGN_UP_ASKS && !existsSync(STATE_FILE()))
    test.skip(true, "atlandı: giriş yapılamadı");
});

/** The page's language is Turkish from the first screen: the run reads Turkish copy. */
async function openApp(page: Page, path = "/app") {
  await openAndSee(page, "/app", (shown) =>
    shown.getByRole("button", { name: "Uygulamaları bağla" }),
  );
  if (path !== "/app") await page.goto(path);
}

test(SIGN_UP_ASKS, async ({ browser }) => {
  const account = trialAccount() as TrialAccount;
  // A signed-out browser of its own, never the trial account's session. A server that mails codes
  // signs up with a name, an address and a code: the page must ask for no password and never call
  // the password sign-up. The run sends no mail and opens no account on either kind of server:
  // every call that could mail a code or open an account is answered inside the browser and never
  // reaches the live server. The pattern is wide (any auth URL naming a code or a sign-up), and a
  // request of that kind the handler did not answer fails the run, so a wrong pattern cannot
  // mail anyone silently.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const { emailCode } = await (await context.request.get("/api/auth/capabilities")).json();
    const risky = /\/api\/auth\/[^?]*(otp|sign-up)/i;
    const seen: string[] = [];
    const answered: string[] = [];
    const bodies: { url: string; body: unknown }[] = [];
    page.on("request", (request) => {
      if (risky.test(request.url())) seen.push(request.url());
    });
    await page.route(risky, async (route) => {
      const request = route.request();
      answered.push(request.url());
      bodies.push({ url: request.url(), body: request.postDataJSON() });
      // Answered as the server would, without reaching it: a sent code, or "address taken".
      if (/sign-up\/email/.test(request.url()))
        await route.fulfill({
          status: 422,
          json: { code: "USER_ALREADY_EXISTS", message: "User already exists" },
        });
      else await route.fulfill({ json: { success: true } });
    });
    await page.goto("/sign-up?lang=tr");
    if (emailCode) {
      await expect(page.getByPlaceholder("Parola")).toHaveCount(0);
      await page.getByPlaceholder("Adınız").fill("Dozo Probe");
      await page.getByPlaceholder("E-posta adresiniz").fill(account.email);
      await page.getByRole("button", { name: "Devam", exact: true }).click();
      await expect(page.getByRole("heading", { name: "E-postanızı kontrol edin" })).toBeVisible();
      expect(
        bodies.map((b) => b.body),
        "one code request, as sign-in",
      ).toEqual([{ email: account.email, type: "sign-in" }]);
      expect(
        seen.filter((url) => /sign-up\/email/.test(url)),
        "the password sign-up was never called",
      ).toEqual([]);
      const session = await (await context.request.get("/api/auth/get-session")).text();
      expect(session.trim(), "the sign-up opened no session").toMatch(/^(null)?$/);
      note("sunucu kodla kayıt istiyor (şifre yok, kod adımı, oturum yok; posta yollanmadı)");
    } else {
      // A server without codes keeps upstream's form. Its sign-up call is answered in the browser
      // (never sent): the live server may not have the trial account, and a real call would open
      // one.
      const choice = page.getByRole("button", { name: "E-posta ile devam et" });
      if (await choice.isVisible()) await choice.click();
      await page.getByPlaceholder("Adınız").fill("Dozo Probe");
      await page.getByPlaceholder("E-posta adresiniz").fill(account.email);
      await page.getByPlaceholder("Parola").fill("Pp-probe-never-sent-1");
      await page.getByRole("button", { name: "Hesap oluştur" }).click();
      await expect(page.getByText("Bu e-postayla bir hesap zaten var")).toBeVisible();
      note("sunucu kodsuz: upstream formu (kayıt isteği tarayıcıda yanıtlandı, sunucuya gitmedi)");
    }
    expect(answered.length, "the catcher answered a request").toBeGreaterThan(0);
    expect(seen, "every code or sign-up request was answered in the browser").toEqual(answered);
    await page.screenshot({ path: `${outDir()}/shots/canli--kayit-kod-ister.png` });
  } finally {
    await context.close();
  }
});

test(SIGN_IN, async ({ page, guard }) => {
  guard.allow(
    /404 POST [^ ]*\/rpc\/billing\/status/,
    "a server without billing answers 404 (local runs)",
  );
  const account = trialAccount() as TrialAccount;
  await page.goto("/sign-in?lang=tr");
  await openPasswordForm(page);
  await page.getByPlaceholder("E-posta adresiniz").fill(account.email);
  await page.getByPlaceholder("Parola").fill(account.password);
  const signIn = page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Oturum aç", exact: true }).click();
  expect((await signIn).status(), "trial account sign-in (is its address verified?)").toBe(200);
  // The first run of a new trial account meets onboarding (the app sends it there after landing on
  // /app); later runs go straight to the app. Wait for what the page shows, not for the address.
  // The live server may ask the survey first: answer the one required question.
  const model = page.getByRole("heading", { name: "Model bağla" });
  const survey = page.getByRole("heading", { name: "Dozo'ya hoş geldiniz" });
  const app = page.getByRole("button", { name: "Uygulamaları bağla" });
  await expect(model.or(survey).or(app).first()).toBeVisible({ timeout: 45_000 });
  if (!(await app.isVisible())) {
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
  }
  await page.waitForURL(/\/app\/[^/?]+/, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Uygulamaları bağla" })).toBeVisible();
  await page.context().storageState({ path: STATE_FILE() });
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
  // The main model section: its heading once the account has a model, or only the
  // "connect a model" picker while it has none. A broken screen shows neither.
  const main = settings.getByTestId("model-role-main");
  await expect(
    main
      .getByText("Ana model", { exact: true })
      .or(main.getByRole("button", { name: "Model bağla", exact: true })),
  ).toBeVisible();
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
  // The computer screen's own notice: the bot settings say the same sentence under Own computer.
  const screen = page.getByTestId("computer-viewport");
  await expect(screen.getByText("Planınızda bilgisayar yok.")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByRole("button", { name: "Yükselt" })).toBeVisible();
  // The other way: a computer of their own, found under the member's devices.
  await expect(screen.getByRole("link", { name: "Cihazların" })).toBeVisible();
});
