import { existsSync, readFileSync } from "node:fs";
import type { Download, Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import type { CoverageRecord, Leak, Scan } from "./scan";
import {
  installProbes,
  mergeScans,
  outDir,
  scanDownload,
  scanPage,
  scanStrings,
  writeCoverage,
} from "./scan";
import { gotoStable } from "./ui";

export { expect } from "@playwright/test";

export type Theme = "light" | "dark";

export type World = {
  user: { email: string; name: string; password: string };
  /** The first bot onboarding creates. */
  chiefId: string;
  /** Two more bots made through the API, so groups can be created through the UI. */
  scoutId: string;
  writerId: string;
};

export const outDirFile = (name: string) => `${outDir()}/${name}`;
export const authFile = () => `${outDir()}/auth.json`;
export const worldFile = () => `${outDir()}/world.json`;

export function readWorld(): World {
  if (!existsSync(worldFile()))
    throw new Error(`${worldFile()} missing: the setup project did not run`);
  return JSON.parse(readFileSync(worldFile(), "utf8")) as World;
}

/** Writes through the API with the page's session, as the app's own client does. */
export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

export const APPEARANCE_KEY = "rakazo.uiAppearance"; // a deliberately unchanged technical identifier

export const test = base.extend<{ theme: Theme }>({
  theme: ["light", { option: true }],
  context: async ({ context, theme }, use) => {
    await installProbes(context);
    await context.addInitScript(
      ([key, value]) => {
        if (localStorage.getItem(key as string) === null)
          localStorage.setItem(key as string, value as string);
      },
      [APPEARANCE_KEY, theme],
    );
    await use(context);
  },
});

export type Ctx = {
  page: Page;
  world: World;
  theme: Theme;
  /** Scans what is on screen now: text, attributes, links, toasts, dialogs and copied strings. */
  scan(label: string): Promise<void>;
  scanDownload(label: string, download: Download): Promise<void>;
  scanStrings(label: string, where: string, texts: string[]): void;
  /** Navigates and waits until the app has drawn (the app keeps a live stream open, so not "networkidle"). */
  goto(path: string): Promise<void>;
  note(text: string): void;
};

export type Surface = {
  name: string;
  group: string;
  /** Inventory keys this surface visits (see inventory.ts). */
  covers?: string[];
  /** Run in the light theme only: creates data, or is too slow to repeat. */
  once?: boolean;
  /** A longer timeout in ms, for surfaces that wait on a slow start. */
  slow?: number;
  /** Needs no session: the test starts signed out. */
  signedOut?: boolean;
  /** Server errors this surface is expected to meet, each with the reason (reported, never hidden). */
  expect5xx?: { pattern: RegExp; reason: string; mustOccur?: boolean }[];
  reach(ctx: Ctx): Promise<void>;
};

export async function runSurface(surface: Surface, page: Page, theme: Theme) {
  const world = surface.signedOut ? (undefined as unknown as World) : readWorld();
  const scans: Scan[] = [];
  const notes: string[] = [];
  const serverErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(
        `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  const label = (suffix: string) => `${surface.name}${suffix ? ` > ${suffix}` : ""} (${theme})`;
  const ctx: Ctx = {
    page,
    world,
    theme,
    async scan(step) {
      scans.push(await scanPage(page, label(step)));
    },
    async scanDownload(step, download) {
      scans.push(await scanDownload(label(step), download));
    },
    scanStrings(step, where, texts) {
      scans.push(scanStrings(label(step), where, texts));
    },
    async goto(path) {
      await gotoStable(page, path);
      // Pages outside the session shell (OAuth callbacks) have no ready marker: wait out the loading states.
      await expect(page.locator('[data-rakazo-app-state="session-pending"]')).toHaveCount(0);
      await expect(page.getByTestId("page-loading")).toHaveCount(0);
      await expect(page.locator("#root *").first()).toBeVisible();
    },
    note(text) {
      notes.push(text);
    },
  };
  const record: CoverageRecord = {
    surface: surface.name,
    group: surface.group,
    theme,
    covers: surface.covers ?? [],
    visited: false,
    elements: 0,
    leaks: [],
    hosts: [],
    urls: [],
    serverErrors: [],
  };
  let failure: unknown;
  try {
    await surface.reach(ctx);
    await expect(
      page.locator('[data-rakazo-app-state="failed"]'),
      "the app's last-resort error screen is showing",
    ).toHaveCount(0);
    await ctx.scan("");
    record.visited = true;
  } catch (error) {
    failure = error;
    // A screen that failed to open is still scanned, so a leak on it is reported next to the failure.
    await ctx.scan("(after failure)").catch(() => undefined);
  }
  const merged = mergeScans(...scans);
  const allowed = surface.expect5xx ?? [];
  const unexpected = serverErrors.filter((line) => !allowed.some((a) => a.pattern.test(line)));
  const expected = serverErrors.filter((line) => allowed.some((a) => a.pattern.test(line)));
  record.elements = merged.elements;
  record.leaks = merged.leaks;
  record.hosts = merged.hosts;
  record.urls = merged.urls;
  record.serverErrors = [...new Set(serverErrors)];
  record.note =
    [
      ...notes,
      ...expected.map(
        (line) => `expected: ${line}: ${allowed.find((a) => a.pattern.test(line))?.reason}`,
      ),
    ].join("; ") || undefined;
  writeCoverage(record);
  if (failure) throw failure;
  expect(unexpected, `server errors on "${surface.name}"`).toEqual([]);
  for (const entry of allowed) {
    if (entry.mustOccur && !serverErrors.some((line) => entry.pattern.test(line))) {
      throw new Error(
        `"${surface.name}" expected ${entry.pattern} (${entry.reason}) and it did not happen: the defect is gone or the state changed. Remove the entry from the surface.`,
      );
    }
  }
  await expect(page, `document title on "${surface.name}"`).toHaveTitle(/Dozo/);
  expect(merged.leaks, leakMessage(merged.leaks)).toEqual([]);
}

export function leakMessage(leaks: Leak[]) {
  return leaks.map((leak) => `${leak.surface}, ${leak.where}: "${leak.text}"`).join("\n");
}
