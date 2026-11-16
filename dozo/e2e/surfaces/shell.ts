import type { Page } from "@playwright/test";
import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { dismiss, openAccountMenu, openBot, openCommandPalette, openCreateMenu } from "../ui";

async function chiefChat(page: Page, id: string) {
  await openBot(page, id, "Chief");
}

export const shell: Surface[] = [
  {
    name: "home (the app root)",
    group: "shell",
    covers: ["route:/app"],
    landsOn: {
      "route:/app": { path: "/app/:botId", reason: "the app root opens the last bot's chat" },
    },
    async reach({ page, goto }) {
      await goto("/app");
      await expect(page).toHaveURL(/\/app\/[^/]+$/);
      await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
    },
  },
  {
    name: "chat: send a message, receive the model's reply",
    group: "chat",
    once: true,
    covers: ["route:/app/:botId"],
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      const replies = page.getByTestId("message-bot-bubble");
      const before = await replies.count();
      const composer = page.getByRole("combobox", { name: "Message Chief" });
      const text = `Tell me what you can do (${Math.random().toString(36).slice(2, 7)}).`;
      await composer.fill(text);
      await composer.press("Enter");
      await expect(page.getByTestId("message-user-bubble").getByText(text)).toBeVisible();
      await expect(replies).toHaveCount(before + 1, { timeout: 60_000 });
      await expect(replies.last()).toContainText("Hello from the offline Dozo test model.");
      await scan("after the reply");
    },
  },
  {
    name: "chat: message actions (hover, more, react, reply)",
    group: "chat",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      const bubble = page.getByTestId("message-bot-bubble").last();
      await bubble.hover();
      await expect(page.getByTestId("message-hover-actions").first()).toBeVisible();
      await scan("hover actions");
      await page.getByRole("button", { name: "More" }).first().click({ force: true });
      await expect(page.getByRole("menu")).toBeVisible();
      await scan("more menu");
      await dismiss(page);
      await bubble.hover();
      await page.getByRole("button", { name: "React" }).first().click({ force: true });
      await scan("reaction picker");
      await dismiss(page);
      await bubble.hover();
      await page.getByRole("button", { name: "Reply" }).first().click({ force: true });
      await expect(
        page.getByTestId("reply-chip").or(page.getByTestId("reply-parent-preview")).first(),
      ).toBeVisible();
    },
  },
  {
    name: "chat: composer menus (attach, slash, mention)",
    group: "chat",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      const composer = page.getByRole("combobox", { name: "Message Chief" });
      await page.getByRole("button", { name: "Attach file" }).click();
      await scan("attach");
      await dismiss(page);
      await composer.fill("/");
      await expect(page.getByTestId("slash-picker")).toBeVisible();
      await scan("slash picker");
      await composer.fill("@");
      await expect(page.getByTestId("mention-picker")).toBeVisible();
      await scan("mention picker");
      await composer.fill("");
    },
  },
  {
    name: "account menu",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      const menu = await openAccountMenu(page);
      await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
      await scan("menu open");
    },
  },
  {
    name: "command palette",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      const palette = await openCommandPalette(page);
      await scan("palette open");
      await palette.getByTestId("command-palette-search").fill("settings");
      await scan("palette filtered");
      await palette.getByTestId("command-palette-search").fill("appearance");
      await scan("palette appearance");
    },
  },
  {
    name: "keyboard shortcuts dialog",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await page.getByRole("combobox", { name: "Message Chief" }).click();
      await page.keyboard.press("ControlOrMeta+/");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await scan("shortcuts");
    },
  },
  {
    name: "sidebar: search",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await page.getByTestId("sidebar-search-trigger").click();
      await expect(page.getByTestId("sidebar-search")).toBeVisible();
      await scan("search open");
      await page.getByTestId("sidebar-search").locator("input").first().fill("Chief");
    },
  },
  {
    name: "sidebar: activity",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await page.getByRole("button", { name: "Activity" }).click();
      await expect(page.getByTestId("activity-list")).toBeVisible();
      await scan("activity list");
    },
  },
  {
    name: "sidebar: space actions and bot menus",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await page.getByRole("button", { name: "Actions for Personal" }).click();
      await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
      await scan("space actions");
      await dismiss(page);
      await page
        .getByTestId("bots-sidebar")
        .getByRole("button", { name: /^Chief/ })
        .first()
        .click({ button: "right" });
      await scan("bot context menu");
      await dismiss(page);
      await page.getByRole("button", { name: "Collapse Personal" }).click();
      await scan("space collapsed");
      await page.getByRole("button", { name: /^Expand Personal/ }).click();
      await page.getByTestId("minimize-bots-sidebar").click();
      await scan("sidebar minimized");
    },
  },
  {
    name: "create menu",
    group: "shell",
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await openCreateMenu(page);
      await expect(page.getByTestId("create-new-bot")).toBeVisible();
      await scan("create menu");
    },
  },
  {
    name: "create bot dialog (cancelled) and creating a bot",
    group: "bots",
    once: true,
    async reach({ page, world, scan }) {
      await chiefChat(page, world.chiefId);
      await openCreateMenu(page);
      await page.getByTestId("create-new-bot").click();
      const dialog = page.getByTestId("create-bot-dialog");
      await expect(dialog).toBeVisible();
      await scan("dialog empty");
      await dialog.getByPlaceholder("Name your Bot").fill("Dozo E2E Bot");
      await scan("dialog filled");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await page.waitForURL(/\/app\/[^/]+$/);
      await expect(dialog).toBeHidden();
      await expect(page.getByPlaceholder("Message Dozo E2E Bot")).toBeVisible();
    },
  },
];
