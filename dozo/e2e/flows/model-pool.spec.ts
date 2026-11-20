import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, rpc } from "../fixtures";
import { outDir } from "../scan";
import { connectModelThroughOnboarding } from "../support";
import { openBot, openUserSettings } from "../ui";
import { newAccount } from "./accounts";
import { expect, test } from "./flow";

const REPLY = "Hello from the offline Dozo test model.";
/** The model stub tells this key its quota ran out (model-stub.mjs). */
const SPENT_KEY = "e2e-spent-key";
const SWITCH = "Use the next connection when one runs out";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/model-pool--${name}.png` });
}

async function openConnection(page: Page, name: string) {
  const settings = await openUserSettings(page, "models");
  await settings.getByTestId("provider-row-name").filter({ hasText: name }).click();
  await expect(settings.getByTestId("model-provider-page")).toBeVisible();
  return settings;
}

/**
 * Two connections to one provider, the main model on the second, whose quota has run out. Turned
 * on from either connection's page, the pool hands the run to the first connection, and the one
 * that ran out shows when it opens again. Its own account: the main model changes.
 */
test("model pool: a run moves to the next connection when one runs out", async ({
  browser,
  guard,
}) => {
  const { context, page } = await newAccount(browser, "pool");
  guard.follow(page);
  try {
    await context.addInitScript((key) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, "light");
    }, APPEARANCE_KEY);
    await connectModelThroughOnboarding(page);
    const botId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) as string;
    await expect(page.getByText(REPLY).first()).toBeVisible({ timeout: 60_000 });
    await rpc(page, "models/connect", {
      provider: "openai-compatible",
      baseUrl: process.env.DOZO_E2E_MODEL_URL,
      apiKey: SPENT_KEY,
      label: "Second key",
      credentialId: null,
      modelId: "dozo-e2e-model",
      makeDefault: true,
    });

    const settings = await openConnection(page, "Second key");
    const toggle = settings.getByRole("switch", { name: SWITCH });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await shot(page, "connection-light");

    await openBot(page, botId, "Chief");
    const replies = page.getByText(REPLY);
    const before = await replies.count();
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("Hello again");
    await composer.press("Enter");
    await expect(replies).toHaveCount(before + 1, { timeout: 90_000 });

    const list = await openUserSettings(page, "models");
    const resting = list.locator("li", { has: page.getByTestId("dozo-opens-at") });
    await expect(resting.getByTestId("dozo-opens-at")).toHaveText(/^Opens at /);
    await expect(resting.getByTestId("provider-row-name")).toContainText("Second key");
    await shot(page, "list-light");

    await page.evaluate((key) => localStorage.setItem(key, "dark"), APPEARANCE_KEY);
    await page.reload();
    await expect(
      (await openUserSettings(page, "models")).getByTestId("dozo-opens-at"),
    ).toBeVisible();
    await shot(page, "list-dark");
    await expect(
      (await openConnection(page, "Second key")).getByRole("switch", { name: SWITCH }),
    ).toBeChecked();
    await shot(page, "connection-dark");
  } finally {
    await context.close();
  }
});
