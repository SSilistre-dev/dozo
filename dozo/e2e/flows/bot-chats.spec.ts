import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, readWorld } from "../fixtures";
import { outDir } from "../scan";
import { openBot } from "../ui";
import { expect, test } from "./flow";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/${name}.png` });
}

const REPLY = "Hello from the offline Dozo test model.";

/** Right-clicks a row and returns its menu. */
async function menuOf(page: Page, row: string) {
  await page.locator(row).click({ button: "right" });
  const menu = page.locator('[data-slot="context-menu-content"]').first();
  await expect(menu).toBeVisible();
  return menu;
}

/** New chat from the bot's row: it opens, and sits under the bot's row. */
async function newChat(page: Page, botId: string) {
  const menu = await menuOf(page, `[data-roster-bot-id="${botId}"]`);
  await menu.getByRole("menuitem", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\?chat=/);
  const chatId = new URL(page.url()).searchParams.get("chat")!;
  const row = page.locator(`[data-dozo-bot-chat="${chatId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "page");
  return { chatId, row: `[data-dozo-bot-chat="${chatId}"]` };
}

async function archive(page: Page, row: string, botId: string) {
  const menu = await menuOf(page, row);
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.locator(row)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
}

/**
 * A bot's second chat: New chat from its row, a message and the bot's reply in it (with a tool the
 * owner approves), the main chat untouched, the chat kept on reload, renamed, then archived. The
 * bot without extra chats looks as before: nothing under its row until one exists.
 */
test("bot chats: a second chat with a bot, from its row to archive", async ({ page }) => {
  const world = readWorld();
  await page.addInitScript((key) => localStorage.setItem(key, "light"), APPEARANCE_KEY);
  await openBot(page, world.chiefId, "Chief");
  await expect(page.locator(`[data-dozo-bot-chats="${world.chiefId}"]`)).toHaveCount(0);
  const mainReplies = await page.getByTestId("message-bot-bubble").count();

  const { chatId, row } = await newChat(page, world.chiefId);
  // Named by when it began, so it reads apart from the action that made it.
  await expect(page.getByTestId("dozo-chat-switcher")).not.toContainText("New chat");
  await expect(page.locator(row)).toContainText(/\d/);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const replies = page.getByTestId("message-bot-bubble");
  await expect(replies).toHaveCount(0);
  await composer.fill("Plan the garden");
  await composer.press("Enter");
  await expect(replies).toHaveCount(1, { timeout: 60_000 });
  await expect(replies.last()).toContainText(REPLY);

  // A tool the owner has not allowed asks first, in this chat.
  const args = Buffer.from('{"url":"https://dozo-e2e.invalid/"}').toString("base64");
  await composer.fill(`Read the page [e2e-tool:web_fetch b64:${args}]`);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /^Allow/ }).first()).toBeVisible({
    timeout: 60_000,
  });

  // Reload keeps the chat; the main chat has none of it.
  await page.reload();
  await expect(page.getByText("Plan the garden")).toBeVisible();
  await expect(page.locator(row)).toHaveAttribute("aria-current", "page");
  await page.locator(`[data-roster-bot-id="${world.chiefId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${world.chiefId}$`));
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(mainReplies);
  await expect(page.getByText("Plan the garden")).toHaveCount(0);

  // Rename from its row's menu: the row and the header say the new name.
  await page.locator(row).click();
  await expect(page).toHaveURL(new RegExp(`chat=${chatId}`));
  const menu = await menuOf(page, row);
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Garden");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(row)).toContainText("Garden");
  await expect(page.getByTestId("dozo-chat-switcher")).toContainText("Garden");
  await shot(page, "app-chats-sidebar-light");

  await archive(page, row, world.chiefId);
});

test("bot chats: the sidebar, the header's chats and a chat's menu in the dark", async ({
  page,
}) => {
  const world = readWorld();
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), APPEARANCE_KEY);
  await openBot(page, world.chiefId, "Chief");
  const { row } = await newChat(page, world.chiefId);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Plan the garden");
  await composer.press("Enter");
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(1, { timeout: 60_000 });
  await shot(page, "app-chats-sidebar-dark");

  // The header's chats: the bot's main chat, this one, and New chat.
  await page.getByTestId("dozo-chat-switcher").click();
  const chats = page.getByRole("menu");
  await expect(chats.getByRole("menuitem", { name: "Chief" })).toBeVisible();
  await expect(chats.getByRole("menuitem", { name: "New chat" }).last()).toBeVisible();
  await shot(page, "app-chats-new-dark");
  await page.keyboard.press("Escape");

  const menu = await menuOf(page, row);
  for (const item of ["Rename", "Mark as Unread", "Snooze", "Export", "Archive"]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await shot(page, "app-chats-menu-dark");
  await page.keyboard.press("Escape");
  await archive(page, row, world.chiefId);
});
