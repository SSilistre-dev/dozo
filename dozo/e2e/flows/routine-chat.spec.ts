import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, readWorld } from "../fixtures";
import { outDir } from "../scan";
import { openBot, openBotPanel } from "../ui";
import { rpcAs } from "./accounts";
import { expect, test } from "./flow";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/${name}.png` });
}

/**
 * A saved routine of a bot with an extra chat picks the chat it posts in, in both themes. Without
 * an open extra chat the editor shows no chat at all.
 */
test("routine chat: a routine of a bot with an extra chat picks where it posts", async ({
  page,
}) => {
  const world = readWorld();
  const name = `E2E routine ${Math.random().toString(36).slice(2, 7)}`;
  const routine = await rpcAs<{ id: string }>(page, "routines/create", {
    botId: world.chiefId,
    name,
    prompt: "Summarize the garden",
    crons: ["0 9 * * *"],
  });
  const editor = async (theme: "light" | "dark") => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
      APPEARANCE_KEY,
      theme,
    ] as const);
    await openBot(page, world.chiefId, "Chief");
    await openBotPanel(page);
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByPlaceholder("Name this routine")).toHaveValue(name);
  };
  const chatPicker = page.getByLabel("Chat", { exact: true });

  try {
    await editor("light");
    await expect(chatPicker).toHaveCount(0);

    const { chat } = await rpcAs<{ chat: { id: string } }>(page, "dozoChats/create", {
      botId: world.chiefId,
      name: "Garden",
    });
    try {
      await editor("light");
      // The picker waits for the bot's chats, read once the editor opens.
      await expect(chatPicker).toBeVisible({ timeout: 20_000 });
      await expect(chatPicker).toHaveValue("");
      await chatPicker.selectOption({ label: "Garden" });
      await expect
        .poll(
          async () =>
            (
              await rpcAs<{ chatId: string | null }>(page, "dozoChats/routineChat", {
                routineId: routine.id,
              })
            ).chatId,
        )
        .toBe(chat.id);
      await shot(page, "routine-chat-light");
      await editor("dark");
      await expect(chatPicker).toHaveValue(chat.id, { timeout: 20_000 });
      await shot(page, "routine-chat-dark");
    } finally {
      await rpcAs(page, "dozoChats/archive", { chatId: chat.id, archived: true });
    }
  } finally {
    await rpcAs(page, "routines/remove", { routineId: routine.id });
  }
});
