import type { Surface } from "../fixtures";
import { expect } from "../fixtures";
import { dismiss, gotoStable, openAccountMenu, openBot } from "../ui";

export const overlays: Surface[] = [
  {
    name: "skills overlay (account menu > Skills)",
    group: "overlays",
    covers: ["overlay:skills"],
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      const menu = await openAccountMenu(page);
      await menu.getByRole("button", { name: "Skills" }).click();
      await expect(page).toHaveURL(/[?&]skills/);
      await expect(page.getByRole("button", { name: "Close skills" })).toBeVisible();
      await scan("skills list");
      await page
        .getByRole("button", { name: /Built-in/ })
        .first()
        .click();
      await scan("a built-in skill");
      await gotoStable(page, `/app/${world.chiefId}?skills`);
      await page.getByRole("button", { name: "New skill" }).click();
      await scan("new skill editor");
    },
  },
  {
    name: "skills: from GitHub dialog",
    group: "overlays",
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await gotoStable(page, `/app/${world.chiefId}?skills`);
      await page.getByRole("button", { name: "From GitHub" }).click();
      await expect(page.getByTestId("skills-git-import")).toBeVisible();
      await scan("git import");
    },
  },
  {
    name: "integrations overlay (Connect apps)",
    group: "overlays",
    covers: ["overlay:integrations"],
    async reach({ page, world, scan }) {
      await openBot(page, world.chiefId, "Chief");
      await page.getByRole("button", { name: "Connect apps" }).click();
      await expect(page.getByRole("button", { name: "Add custom", exact: true })).toBeVisible();
      await scan("catalog");
      await page.getByRole("button", { name: "Communication", exact: true }).click();
      await scan("category");
      const add = page.getByRole("button", { name: "Add custom", exact: true });
      await add.click();
      await scan("add custom menu");
      const count = await page.getByRole("menuitem").count();
      await dismiss(page);
      for (let i = 0; i < count; i++) {
        if (!(await add.isVisible().catch(() => false))) {
          await openBot(page, world.chiefId, "Chief");
          await page.getByRole("button", { name: "Connect apps" }).click();
        }
        await add.click();
        await page.getByRole("menuitem").nth(i).click();
        await scan(`custom source ${i + 1}`);
        await dismiss(page);
      }
    },
  },
  {
    name: "bot templates overlay and a template",
    group: "overlays",
    covers: ["overlay:templates"],
    async reach({ page, world, scan }) {
      await gotoStable(page, `/app/${world.chiefId}?templates`);
      await expect(page.getByRole("button", { name: "Close bot templates" })).toBeVisible();
      await scan("template list");
      await page.getByTestId("bot-template-card").first().click();
      await expect(page.getByTestId("bot-template-detail")).toBeVisible();
      await scan("template detail");
    },
  },
  {
    name: "MCP servers overlay",
    group: "overlays",
    covers: ["overlay:mcp"],
    async reach({ page, world, scan }) {
      await gotoStable(page, `/app/${world.chiefId}?mcp`);
      await expect(page.getByRole("button", { name: "Close MCP servers" })).toBeVisible();
      await scan("add server form");
      await page.getByRole("button", { name: "Advanced" }).click();
      await scan("advanced");
      await page.getByText("SSE", { exact: true }).click();
      await scan("SSE transport");
      await dismiss(page);
    },
  },
];
