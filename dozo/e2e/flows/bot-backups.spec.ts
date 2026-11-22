import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { APPEARANCE_KEY, rpc } from "../fixtures";
import { outDir } from "../scan";
import { connectModelThroughOnboarding } from "../support";
import { openBot, openBotSettings } from "../ui";
import { newAccount } from "./accounts";
import { expect, test } from "./flow";

const MODEL = "dozo-e2e-model";

async function shot(page: Page, target: Locator, name: string) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      ),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]),
  );
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/bot-backups--${name}.png` });
}

/**
 * A bot's own backup: one Add fallback line under its model, a pick from the person's own
 * connections, kept after a reload, and removed again. Both themes. Its own account: a second
 * connection is added.
 */
test("bot backups: a bot keeps its own ordered backup models", async ({ browser, guard }) => {
  const { context, page } = await newAccount(browser, "backups");
  guard.follow(page);
  try {
    await connectModelThroughOnboarding(page);
    const botId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) as string;
    await rpc(page, "models/connect", {
      provider: "openai-compatible",
      baseUrl: process.env.DOZO_E2E_MODEL_URL,
      apiKey: "e2e-second-key",
      label: "Second key",
      credentialId: null,
      modelId: MODEL,
      makeDefault: false,
    });

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        APPEARANCE_KEY,
        theme,
      ]);
      await openBot(page, botId, "Chief");
      await openBotSettings(page);
      const settings = page.getByTestId("bot-settings");
      const add = settings.getByRole("button", { name: "Add fallback" });
      await expect(add).toBeVisible();
      if (theme === "light") await shot(page, add, `1-empty-${theme}`);

      await add.click();
      const picker = page.getByRole("dialog").or(page.locator("[cmdk-root]")).last();
      const second = picker.getByRole("group", { name: "Second key" }).getByRole("option");
      await expect(second.first()).toBeVisible();
      await shot(page, second.first(), `2-picker-${theme}`);
      await second.first().click();

      const list = settings.getByTestId("dozo-bot-backups");
      await expect(list.getByRole("listitem").filter({ hasText: "Second key" })).toBeVisible();
      await page.reload();
      await openBotSettings(page);
      const row = settings.getByTestId("dozo-bot-backups").getByRole("listitem").first();
      await expect(row).toContainText("Second key");
      await shot(page, row, `3-saved-${theme}`);

      await row.getByRole("button", { name: /options$/ }).click();
      await page.getByRole("menuitem", { name: "Remove" }).click();
      await expect(
        settings.getByTestId("dozo-bot-backups").getByRole("listitem").filter({ hasText: "Second key" }),
      ).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});
