import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { test as flow } from "../flows/flow";
import { outDir } from "../scan";
import { deadLinks } from "./budgets";
import { fenceVerdict, isNetworkFlap } from "./fence";

export { expect, SIGNED_OUT } from "../flows/flow";

/** The throwaway account of this run: created by the sign-up scenario, deleted at the end. */
export type Probe = { email: string; password: string; deleted: boolean };

const PROBE_FILE = () => `${outDir()}/probe.json`;
export const STATE_FILE = () => `${outDir()}/probe-state.json`;

/** A fresh address on the owner's own mailbox; the password never leaves this run's files. */
export function newProbe(): Probe {
  const id = Math.random().toString(36).slice(2, 10);
  const secret = Array.from({ length: 3 }, () => Math.random().toString(36).slice(2)).join("");
  return { email: `info+dozo-probe${id}@ssilistre.dev`, password: `Pp-${secret}`, deleted: false };
}

export function readProbe(): Probe | null {
  return existsSync(PROBE_FILE())
    ? (JSON.parse(readFileSync(PROBE_FILE(), "utf8")) as Probe)
    : null;
}

export function saveProbe(probe: Probe) {
  writeFileSync(PROBE_FILE(), JSON.stringify(probe), { mode: 0o600 });
}

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
export const test = flow.extend<{ fence: undefined }>({
  // A navigation that meets this machine's own network change is tried again, at most twice; a
  // site error (4xx/5xx, a timeout, wrong content) is never retried.
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await goto(url, options);
        } catch (error) {
          if (attempt >= 2 || !isNetworkFlap(String(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    };
    await use(page);
  },
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
 * Deletes the probe with its own session and proves it is gone: the same email and password are
 * refused and no session is left. Returns what it saw, for the report.
 */
export async function deleteProbe(request: APIRequestContext, probe: Probe): Promise<string> {
  const origin = process.env.CANLI_URL as string;
  const headers = { origin, "content-type": "application/json" };
  let session = await request.get("/api/auth/get-session", { headers });
  let signedIn = session.ok() && (await session.text()).includes(probe.email);
  if (!signedIn) {
    const signIn = await request.post("/api/auth/sign-in/email", {
      headers,
      data: { email: probe.email, password: probe.password },
    });
    if (signIn.status() === 401) return "already gone: sign-in refused with 401";
    signedIn = signIn.ok();
  }
  if (!signedIn) throw new Error("cannot sign the probe in to delete it");
  const deleted = await request.post("/api/auth/delete-user", {
    headers,
    data: { password: probe.password },
  });
  if (!deleted.ok()) throw new Error(`delete-user answered ${deleted.status()}`);
  const again = await request.post("/api/auth/sign-in/email", {
    headers,
    data: { email: probe.email, password: probe.password },
  });
  session = await request.get("/api/auth/get-session", { headers });
  const left = (await session.text()).trim();
  if (again.status() !== 401) throw new Error(`sign-in after delete answered ${again.status()}`);
  if (left !== "null" && left !== "") throw new Error("a session is left after the delete");
  return `delete-user ${deleted.status()}; sign-in again 401; session null`;
}
