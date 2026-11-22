import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { APPEARANCE_KEY, rpc } from "../fixtures";
import { outDir } from "../scan";
import { connectModelThroughOnboarding } from "../support";
import { openBot, openUserSettings } from "../ui";
import { newAccount } from "./accounts";
import { expect, test } from "./flow";

const MODEL = "dozo-e2e-model";
const REPLY = "Hello from the offline Dozo test model.";
/** The model stub tells this key its quota ran out (model-stub.mjs). */
const SPENT_KEY = "e2e-spent-key";

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
  await page.screenshot({ path: `${outDir()}/shots/backup-replies--${name}.png` });
}

/**
 * The main model on a connection whose quota ran out, a backup on another: the reply comes from
 * the backup, and Models settings says when the main model opens again. Both themes. Its own
 * account: the main model changes. The reply's menu line needs a backup of another model, which
 * the model stub (one model) cannot serve; dozo-message-revision.test.tsx covers it.
 */
test("backup replies: a resting main model says when it opens again", async ({
  browser,
  guard,
}) => {
  const { context, page } = await newAccount(browser, "backup-replies");
  guard.follow(page);
  guard.allow(
    /^failed: net::ERR_FAILED GET [^ ]+\/assets\/[^ ]+\.js$/,
    "a reload or a new page cancels the app's idle fetch of its lazy screens; each screen this flow opens is checked on screen",
  );
  try {
    await connectModelThroughOnboarding(page);
    const botId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) as string;
    await expect(page.getByText(REPLY).first()).toBeVisible({ timeout: 60_000 });
    await rpc(page, "models/connect", {
      provider: "openai-compatible",
      baseUrl: process.env.DOZO_E2E_MODEL_URL,
      apiKey: SPENT_KEY,
      label: "Spent key",
      credentialId: null,
      modelId: MODEL,
      makeDefault: false,
    });
    const connections = await rpc<Array<{ id: string; label: string | null }>>(
      page,
      "models/credentials",
      {},
    );
    const spent = connections.find((connection) => connection.label === "Spent key")!.id;
    const good = connections.find((connection) => connection.id !== spent)!.id;
    const choice = (credentialId: string) => ({
      provider: "openai-compatible",
      modelId: MODEL,
      credentialId,
    });
    await rpc(page, "models/setRole", {
      role: "main",
      primary: choice(spent),
      backups: [choice(good)],
    });

    await openBot(page, botId, "Chief");
    const replies = page.getByText(REPLY);
    const before = await replies.count();
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("Hello again");
    await composer.press("Enter");
    await expect(replies).toHaveCount(before + 1, { timeout: 90_000 });

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        APPEARANCE_KEY,
        theme,
      ]);
      await openBot(page, botId, "Chief");
      const settings = await openUserSettings(page, "models");
      const main = settings.getByTestId("model-role-main").getByTestId("model-role-row-1");
      await expect(main).toContainText(/Opens at /);
      await shot(page, main, `settings-${theme}`);
    }
  } finally {
    await context.close();
  }
});
