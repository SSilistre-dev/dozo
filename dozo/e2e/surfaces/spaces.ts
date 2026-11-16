import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { gotoStable, openBot, openCreateMenu } from "../ui";

export const spaces: Surface[] = [
  {
    name: "group: create and open",
    group: "groups",
    once: true,
    covers: ["route:/app/g/:groupId"],
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await openCreateMenu(page);
      await page.getByTestId("create-new-group").click();
      const panel = page.getByTestId("side-panel");
      await page.locator("label:has-text('Name') input").fill("Dozo E2E team");
      await panel.getByRole("checkbox", { name: "Add Scout to the group" }).click();
      await panel.getByRole("checkbox", { name: "Add Writer to the group" }).click();
      await scan("new group form");
      await page.getByRole("button", { name: "Create group", exact: true }).click();
      await page.waitForURL(/\/app\/g\/[^/]+$/);
      await expect(page.getByTestId("bot-settings-trigger")).toBeVisible();
      await scan("group chat");
      await page.getByTestId("bot-settings-trigger").click();
      await expect(page.getByTestId("side-panel")).toBeVisible();
      await scan("group panel");
    },
  },
  {
    name: "space: create, empty state, settings, invite link",
    group: "spaces",
    once: true,
    covers: ["settings:space"],
    async reach({ page, world, scan }) {
      const name = `Dozo E2E space ${Math.random().toString(36).slice(2, 6)}`;
      await openBot(page, world.chiefId, "Chief");
      await openCreateMenu(page);
      await page.getByTestId("create-new-space").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await scan("new space dialog");
      await dialog.getByRole("textbox").first().fill(name);
      await dialog.getByRole("button", { name: "Create space" }).click();
      await expect(page.getByRole("button", { name: `Actions for ${name}` })).toBeVisible();
      await scan("space created (empty state)");
      await page.getByRole("button", { name: `Actions for ${name}` }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      const settings = page.getByTestId("user-settings");
      await expect(settings).toHaveAttribute("data-settings-section", "space");
      await scan("space settings");
      await settings.getByRole("button", { name: "Invite" }).click();
      await expect(page.getByText("Invite link copied")).toBeVisible();
      await scan("after Invite (toast, clipboard)");
      const link = await page.evaluate(() => (window as unknown as { __dozo: { clipboard: string[] } }).__dozo.clipboard.at(-1));
      expect(link, "the invite link was not copied").toMatch(/\/invite\//);
      expect(new URL(link as string).host, "invite link host").toBe(new URL(page.url()).host);
      await settings.getByRole("button", { name: "Customize Models" }).click();
      await scan("customize the space's models");
      // The owner opens the link they just made: the invite page for a real token.
      await gotoStable(page, new URL(link as string).pathname);
      await expect(page.locator("#root *").first()).toBeVisible();
      await scan("invite page, valid token, opened by the owner");
    },
  },
];
