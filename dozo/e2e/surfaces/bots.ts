import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { expandAll, openBot, openBotPanel, openBotSettings, dismiss } from "../ui";

export const bots: Surface[] = [
  {
    name: "bot panel: profile, computer card, routines",
    group: "bot",
    async reach({ page, world }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await expect(page.getByTestId("routine-create-button")).toBeVisible();
    },
  },
  {
    name: "bot panel: more actions (export, clear conversation)",
    group: "bot",
    async reach({ page, world, scan, scanDownload }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await page.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Export" })).toBeVisible();
      await scan("menu");
      const download = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "Export" }).click();
      await scanDownload("export file", await download);
      await openBotPanel(page);
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Clear conversation" }).click();
      await expect(page.getByTestId("confirm-dialog").or(page.getByRole("alertdialog")).first()).toBeVisible();
      await scan("clear conversation confirm");
      await dismiss(page);
    },
  },
  {
    name: "bot panel: avatar studio",
    group: "bot",
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await page.getByTestId("avatar-studio-trigger").click();
      await expect(page.getByTestId("avatar-studio")).toBeVisible();
      await scan("bot tab");
      const upload = page.getByRole("tab", { name: "Upload" }).or(page.getByRole("button", { name: "Upload" }));
      if (await upload.first().isVisible()) {
        await upload.first().click();
        await scan("upload tab");
      }
    },
  },
  {
    name: "bot panel: edit name",
    group: "bot",
    async reach({ page, world }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await page.getByRole("button", { name: "Edit name" }).click();
      await expect(page.getByTestId("bot-profile-header").getByRole("textbox").first()).toBeVisible();
    },
  },
  {
    name: "bot panel: settings (every section unfolded)",
    group: "bot",
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotSettings(page);
      await scan("settings open");
      await expandAll(page, page.getByTestId("bot-settings"));
    },
  },
  {
    name: "bot panel: new routine editor",
    group: "bot",
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openBotPanel(page);
      await page.getByTestId("routine-create-button").click();
      await expect(page.getByRole("button", { name: "Add trigger" })).toBeVisible();
      await scan("editor");
      await page.getByRole("button", { name: "Add trigger" }).click();
      await scan("add trigger menu");
      await dismiss(page);
      const advanced = page.getByRole("button", { name: "Advanced" });
      if (await advanced.isVisible()) {
        await advanced.click();
        await scan("advanced");
      }
    },
  },
];
