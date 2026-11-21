import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { Theme } from "../fixtures";
import { APPEARANCE_KEY } from "../fixtures";
import { outDir } from "../scan";
import { openBot } from "../ui";
import { rpcAs } from "./accounts";
import { expect, test } from "./flow";

const REPLY = "Hello from the offline Dozo test model.";
const TOOL_DONE = "The offline test model saw the tool finish.";

async function shoot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/${name}.png` });
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [APPEARANCE_KEY, theme]);
  await page.reload();
}

/** A person's message in the open chat, by its words. */
const asked = (page: Page, text: string) =>
  page
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: text })
    .first();

async function openMore(page: Page, text: string) {
  const row = asked(page, text);
  await row.hover();
  await row.getByRole("button", { name: "More" }).click();
}

/**
 * Two quiet turns: the first message can be edited after the confirm that the later ones go, and
 * the chat then holds that message and its new reply only. Once a later turn called a tool, the
 * earlier message offers neither Edit nor the confirm.
 */
test("revision: an earlier message is edited after a confirm, and not past a tool call", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const name = `Rewind ${Math.random().toString(36).slice(2, 7)}`;
  const bot = await rpcAs<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await openBot(page, bot.id, name);
  await setTheme(page, "dark");
  const composer = page.getByRole("combobox", { name: `Message ${name}` });
  const replies = page.getByTestId("message-bot-bubble");
  for (const [index, text] of ["Plan dinner", "Make it vegan"].entries()) {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(replies).toHaveCount(index + 1, { timeout: 60_000 });
    await expect(replies.last()).toContainText(REPLY);
  }

  await openMore(page, "Plan dinner");
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await shoot(page, "app-edit-earlier-dark");
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove the messages after it?");
  await shoot(page, "app-edit-earlier-confirm-dark");
  await confirm.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Edit" });
  await expect(editor).toHaveValue("Plan dinner");
  await editor.fill("Plan lunch");
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(asked(page, "Make it vegan")).toHaveCount(0, { timeout: 30_000 });
  await expect(asked(page, "Plan lunch")).toBeVisible();
  await expect(replies).toHaveCount(1, { timeout: 60_000 });
  await expect(replies.last()).toContainText(REPLY);

  // A later turn wrote to the bot's memory: the earlier message can no longer go back.
  await composer.fill('Remember it [e2e-tool:remember {"content":"Lunch is vegan"}]');
  await composer.press("Enter");
  await expect(page.getByText(TOOL_DONE).last()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => {
      const runs = await rpcAs<{ runs: Array<{ botId: string }> }>(page, "runs/list", {
        filter: "active",
      });
      return runs.runs.some((run) => run.botId === bot.id);
    })
    .toBe(false);
  await setTheme(page, "light");
  const read = page.waitForResponse((r) => r.url().includes("dozoMessages/revisable"));
  await openMore(page, "Plan lunch");
  const named = (await (await read).json()) as { json: Record<string, unknown> };
  expect(named.json.earlierEditMessageIds).toBeUndefined();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

/** The same menu and confirm in the light theme. */
test("revision: the earlier message's menu in the light theme", async ({ page }) => {
  test.setTimeout(180_000);
  const name = `Rewind ${Math.random().toString(36).slice(2, 7)}`;
  const bot = await rpcAs<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await openBot(page, bot.id, name);
  await setTheme(page, "light");
  const composer = page.getByRole("combobox", { name: `Message ${name}` });
  const replies = page.getByTestId("message-bot-bubble");
  for (const [index, text] of ["Plan dinner", "Make it vegan"].entries()) {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(replies).toHaveCount(index + 1, { timeout: 60_000 });
  }
  await openMore(page, "Plan dinner");
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await shoot(page, "app-edit-earlier-light");
  await page.keyboard.press("Escape");
});
