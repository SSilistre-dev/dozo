import { mkdirSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import { outDir } from "../scan";

export { expect } from "@playwright/test";

/**
 * What a scenario may meet without failing: a response or console line matching `pattern`, with
 * the reason. Everything else that is a console error, an uncaught page error or a 4xx/5xx
 * answer fails the scenario after it ran (and after its screenshot was taken).
 */
export type Guard = {
  allow(pattern: RegExp, reason: string): void;
  /** The page leaves the app for a third party's (a payment page): stop judging what it logs. */
  leaveApp(): void;
  /** A page of another browser (another account): watched too, and its screen is the picture. */
  follow(page: Page): void;
};

/** Requests the browser makes on its own, never part of a scenario's verdict. */
const BACKGROUND = /\/favicon|\/manifest|\/analytics\/|\/monitoring/;

/** A file name for the scenario's last screen: `<project>--<title>.png`. */
export function shotName(info: TestInfo) {
  const ascii: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[çğıöşü]/g, (letter) => ascii[letter] ?? letter)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
  return `${slug(info.project.name || "canli")}--${slug(info.titlePath.slice(1).join(" "))}.png`;
}

/** Records the problems a page shows; `problems()` lists the ones no allowance covers. */
export function watch(page: Page) {
  const seen: string[] = [];
  const allowed: RegExp[] = [];
  let watching = true;
  page.on("console", (message) => {
    if (!watching || message.type() !== "error") return;
    const text = message.text();
    // The browser's own line for a failed response; the response itself is judged below.
    // The browser's own line for a failed load names no address: the response and requestfailed
    // listeners below record the same failure with its address.
    if (/^Failed to load resource: /.test(text)) return;
    seen.push(`console: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (error) => {
    if (watching) seen.push(`pageerror: ${error.message.slice(0, 300)}`);
  });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "failed";
    // A request the page itself dropped (a navigation, an unmounted screen) is not a failure. The
    // browser shares the host's network (run.sh, Linux), which changes whenever a container
    // anywhere on the machine starts or stops; the app retries, it is not at fault.
    if (!watching || /ERR_ABORTED|ERR_NETWORK_CHANGED/.test(error)) return;
    const url = new URL(request.url());
    if (BACKGROUND.test(url.pathname)) return;
    seen.push(`failed: ${error} ${request.method()} ${url.host}${url.pathname}`);
  });
  page.on("response", (response) => {
    if (!watching || response.status() < 400) return;
    const url = new URL(response.url());
    if (BACKGROUND.test(url.pathname)) return;
    seen.push(`${response.status()} ${response.request().method()} ${url.host}${url.pathname}`);
  });
  return {
    allow(pattern: RegExp) {
      allowed.push(pattern);
    },
    leave() {
      watching = false;
    },
    problems: () => seen.filter((line) => !allowed.some((pattern) => pattern.test(line))),
  };
}

/**
 * Every scenario: its screens are watched for console errors and unexpected 4xx/5xx answers, and
 * its last screen is saved to `<out>/shots/` whether it passed or not.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page }, use, info) => {
      const allowed: RegExp[] = [];
      const watchers = [watch(page)];
      let shown = page;
      await use({
        allow: (pattern) => {
          allowed.push(pattern);
          for (const watcher of watchers) watcher.allow(pattern);
        },
        leaveApp: () => {
          for (const watcher of watchers) watcher.leave();
        },
        follow: (other) => {
          const watcher = watch(other);
          for (const pattern of allowed) watcher.allow(pattern);
          watchers.push(watcher);
          shown = other;
        },
      });
      // A skipped scenario showed nothing worth a picture.
      if (info.status === "skipped") return;
      mkdirSync(`${outDir()}/shots`, { recursive: true });
      const name = shotName(info);
      const taken = await shown.screenshot({ path: `${outDir()}/shots/${name}` }).then(
        () => true,
        () => false,
      );
      // The live report links each scenario to its picture by this name.
      if (taken) await info.attach("shot", { body: name, contentType: "text/plain" });
      expect(
        watchers.flatMap((watcher) => watcher.problems()),
        "console errors or unexpected 4xx/5xx answers",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

/** A fresh, signed-out browser state for scenarios that make their own account. */
export const SIGNED_OUT = { cookies: [], origins: [] };
