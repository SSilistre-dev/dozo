import { existsSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect as expectFlow, test as flow } from "../flows/flow";
import { watchLoad } from "../load-watch";
import { outDir } from "../scan";
import { deadLinks } from "./budgets";
import { fenceVerdict, guardFlaps } from "./fence";

export { expect, SIGNED_OUT } from "../flows/flow";

/** The signed-in session of the run's trial account, saved by the sign-in scenario. */
export const STATE_FILE = () => `${outDir()}/probe-state.json`;

/** Records a measured number for the report's budget table (canli/budgets.ts). */
export function measure(key: string, value: number) {
  flow.info().annotations.push({ type: "measure", description: JSON.stringify({ key, value }) });
}

export function note(text: string) {
  flow.info().annotations.push({ type: "note", description: text });
}

/**
 * Every scenario of the live run: the e2e scenario fixture (console and 4xx/5xx watch, a picture
 * of the last screen) plus a fence (canli/fence.ts) that refuses any admin, grant, plugin-review or
 * billing-portal call that is not a known read, so a misclick can never ban, pay or administer
 * anything; an unknown procedure is refused too.
 */
export const test = flow.extend<{ flaps: undefined; fence: undefined }>({
  // This machine's own network flap is tried again (canli/fence.ts, guardFlaps): the document at
  // most twice per navigation, the page reloaded at most twice when one of its requests broke,
  // each retry a note in the report. A site error (4xx/5xx, a timeout, wrong content) is never
  // retried, and the watcher still counts it.
  flaps: [
    async ({ page, guard }, use, info) => {
      const flaps = guardFlaps(page, {
        allow: (line) => guard.allow(line, "retried: this machine's network flapped"),
        note: (text) => info.annotations.push({ type: "note", description: text }),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      await use(undefined);
      await flaps.settled();
    },
    { auto: true },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's first parameter as an object pattern
  storageState: async ({}, use) => {
    await use(existsSync(STATE_FILE()) ? STATE_FILE() : { cookies: [], origins: [] });
  },
  fence: [
    async ({ page, guard }, use) => {
      guard.allow(
        /static\.cloudflareinsights\.com/,
        "FINDING (known): the CDN injects its analytics beacon, which the app's own CSP blocks",
      );
      const refused: string[] = [];
      await page.route("**/rpc/**", (route) => {
        const verdict = fenceVerdict(new URL(route.request().url()).pathname);
        if (verdict.pass) return route.continue();
        refused.push(verdict.reason);
        return route.abort();
      });
      await use(undefined);
      if (refused.length) throw new Error(`the live run's fence refused: ${refused.join("; ")}`);
    },
    { auto: true },
  ],
});

/** Every link on the screen that points at a placeholder (`dozo.example`, `OWNER/`). */
export async function placeholderLinks(page: Page): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
  );
  return deadLinks(hrefs);
}

/**
 * Opens `path` and waits for `shown`. A load that stalls fails as before, and the report names
 * the requests that never finished and the ones that failed, the clue to why.
 */
export async function openAndSee(page: Page, path: string, shown: (page: Page) => Locator) {
  const load = watchLoad(page);
  await page.goto(path);
  try {
    await expectFlow(shown(page)).toBeVisible();
  } catch (error) {
    note(`${path} açılışı takıldı; ${load.report()}`);
    throw error;
  }
}

/** First contentful paint of the page's current document, in ms (null before it painted). */
export async function firstContent(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolve) => {
        const now = performance.getEntriesByName("first-contentful-paint")[0];
        if (now) return resolve(now.startTime);
        new PerformanceObserver((list) => resolve(list.getEntries()[0]?.startTime ?? null)).observe(
          {
            type: "paint",
            buffered: true,
          },
        );
        setTimeout(() => resolve(null), 10_000);
      }),
  );
}

/**
 * Opens the password form of the Turkish sign-in page, on the email-first screen ("Bunun yerine
 * şifre kullan") and on the earlier one alike (the password form, or "E-posta ile devam et" after
 * a choice of providers), so the live scenarios pass before and after a deploy of either.
 */
export async function openPasswordForm(page: Page) {
  const password = page.getByRole("button", { name: "Bunun yerine şifre kullan" });
  const choice = page.getByRole("button", { name: "E-posta ile devam et" });
  const field = page.getByPlaceholder("Parola");
  await expectFlow(password.or(choice).or(field).first()).toBeVisible();
  if (await password.isVisible()) await password.click();
  else if (await choice.isVisible()) await choice.click();
  await expectFlow(field).toBeVisible();
}
