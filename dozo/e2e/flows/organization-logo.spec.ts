import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, readWorld } from "../fixtures";
import { outDir } from "../scan";
import { dismiss, openBot, openUserSettings } from "../ui";
import { expect, test } from "./flow";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/organization-logo--${name}.png` });
}

/** A logo as a person would pick one: a dark ring on a transparent PNG, drawn in the page. */
async function ringLogo(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.strokeStyle = "#1d1d1f";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(48, 48, 32, 0, Math.PI * 2);
    ctx.stroke();
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

const sidebarLogo = (page: Page) => page.getByTestId("organization-mark").getByRole("img");

/**
 * The owner uploads a logo in Settings, Organization; the server stores its own square picture and
 * the sidebar header shows it, in both themes. Removing it gives the header back as it was.
 */
test("organization logo: upload in settings, shown in the sidebar header, removed again", async ({
  page,
}) => {
  const world = readWorld();
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), APPEARANCE_KEY);
  await openBot(page, world.chiefId, "Chief");
  await expect(page.getByTestId("organization-mark")).toHaveCount(0);

  const settings = await openUserSettings(page, "organization");
  await expect(settings.getByRole("button", { name: "Upload" })).toBeVisible();
  await settings.getByTestId("organization-logo-file").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: await ringLogo(page),
  });
  await expect(settings.getByRole("button", { name: "Remove" })).toBeVisible();
  const stored = settings.locator("img").first();
  await expect(stored).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await shot(page, "1-settings-dark");

  await dismiss(page);
  await expect(sidebarLogo(page)).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await shot(page, "2-sidebar-dark");

  await page.evaluate((key) => localStorage.setItem(key, "light"), APPEARANCE_KEY);
  await page.addInitScript((key) => localStorage.setItem(key, "light"), APPEARANCE_KEY);
  await openBot(page, world.chiefId, "Chief");
  await expect(sidebarLogo(page)).toBeVisible();
  await shot(page, "3-sidebar-light");
  const again = await openUserSettings(page, "organization");
  await shot(page, "4-settings-light");

  await again.getByRole("button", { name: "Remove" }).click();
  await expect(again.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await dismiss(page);
  await expect(page.getByTestId("organization-mark")).toHaveCount(0);
});
