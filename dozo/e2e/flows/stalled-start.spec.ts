import type { Browser, Locator, Page } from "@playwright/test";
import { outDir } from "../scan";
import { expect, SIGNED_OUT, test } from "./flow";

/**
 * No single request that never answers may leave a start on an empty or spinning screen. Each
 * request a normal start makes is held unanswered in turn, in a fresh browser (no service worker,
 * cold cache), and within `LIMIT_MS` the page must show either its content or the app's
 * unreachable/retry screen. Once for the signed-in app, once for the signed-out sign-in page.
 */

/** The longest wait the fix allows: a boot read's deadline twice (catalog, then English) and some. */
const LIMIT_MS = 25_000;

/**
 * Not held: the page itself, and the two tiny scripts the page runs before it draws (the theme,
 * and the boot shell that watches for a stall); a browser waits on those and nothing on the page
 * can answer for them. They are same-origin files of a few hundred bytes.
 */
const NOT_HELD = new Set(["/theme.js", "/dozo-boot.js"]);

const UNREACHABLE =
  /Can't reach the server\.|Retry now|Something went wrong\. Try again\.|Sunucuya ulaşılamıyor\.|Şimdi tekrar dene|Bir şeyler ters gitti/;

type Start = {
  path: string;
  state: string | typeof SIGNED_OUT;
  content: (page: Page) => Locator;
};

/** Same-origin paths a normal start asks for before its content shows. */
async function requestsOf(browser: Browser, start: Start): Promise<string[]> {
  const context = await browser.newContext({ storageState: start.state });
  const page = await context.newPage();
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const paths = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && request.resourceType() !== "document") paths.add(url.pathname);
  });
  await page.goto(start.path);
  await expect(start.content(page)).toBeVisible();
  await context.close();
  return [...paths].filter((path) => !NOT_HELD.has(path));
}

/** What the page shows within `LIMIT_MS` while `held` never answers. */
async function withHeld(browser: Browser, start: Start, held: string) {
  const context = await browser.newContext({ storageState: start.state });
  await context.route(
    (url) => url.pathname === held,
    () => {
      // Never answered, never failed: a stalled connection.
    },
  );
  const page = await context.newPage();
  const began = Date.now();
  await page.goto(start.path, { waitUntil: "commit" });
  const content = start.content(page);
  const unreachable = page.getByText(UNREACHABLE).first();
  const shown = await content
    .or(unreachable)
    .first()
    .waitFor({ timeout: LIMIT_MS })
    .then(
      async () => ((await content.isVisible()) ? "content" : "retry"),
      () => "blank",
    );
  const took = Date.now() - began;
  await context.close();
  return { held, shown, took };
}

const starts: Record<string, Start> = {
  app: {
    path: "/app",
    state: `${outDir()}/auth.json`,
    content: (page) => page.getByRole("button", { name: "Connect apps" }),
  },
  "sign-in": {
    path: "/sign-in?lang=tr",
    state: SIGNED_OUT,
    content: (page) => page.getByRole("heading", { name: "Dozo'da oturum açın" }),
  },
};

for (const [name, start] of Object.entries(starts)) {
  test(`stalled start (${name}): every request held unanswered still ends in content or a retry`, async ({
    browser,
  }) => {
    const held = await requestsOf(browser, start);
    test.setTimeout((held.length + 2) * (LIMIT_MS + 5_000));
    const results = [];
    for (const path of held) results.push(await withHeld(browser, start, path));
    const table = results.map(
      (r) => `${r.shown.padEnd(7)} ${String(r.took).padStart(6)} ms  ${r.held}`,
    );
    await test
      .info()
      .attach(`stalled-start-${name}`, { body: table.join("\n"), contentType: "text/plain" });
    expect(held.length, "requests a normal start makes").toBeGreaterThan(3);
    expect(
      results.filter((r) => r.shown === "blank").map((r) => r.held),
      `held requests that left the page blank after ${LIMIT_MS} ms:\n${table.join("\n")}`,
    ).toEqual([]);
  });
}
