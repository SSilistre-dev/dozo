import type { Page } from "@playwright/test";
import type { Ctx, Surface } from "../fixtures";
import { expect } from "../fixtures";
import type { SettingsId } from "../ui";
import { dismiss, expandAll, openBot, openEachPopup, openUserSettings } from "../ui";

/** What to open inside each section, beyond the page itself. */
const extras: Partial<Record<SettingsId, (ctx: Ctx) => Promise<void>>> = {
  async general({ page, world, scan, scanDownload }) {
    const settings = page.getByTestId("user-settings");
    // Exporting asks for the password first (not again within a few minutes of confirming it).
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await settings.getByRole("button", { name: "Export data" }).click();
    const identity = page.getByRole("dialog").filter({ hasText: "Confirm it's you" });
    if (await identity.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
      await scan("confirm identity dialog");
      await identity.getByLabel("Password", { exact: true }).fill(world.user.password);
      await identity.getByRole("button", { name: "Continue" }).click();
    }
    await scanDownload("account export", await download);
    await settings.getByTestId("delete-account").scrollIntoViewIfNeeded();
    await settings.getByTestId("delete-account").click();
    await expect(page.getByRole("dialog").or(page.getByRole("alertdialog")).first()).toBeVisible();
    await scan("delete account dialog");
    await dismiss(page);
  },
  async models({ page, scan }) {
    const main = page.getByTestId("model-role-main");
    await expect(main.getByTestId("model-role-row-1")).toContainText("dozo-e2e-model");
    await scan("model roles");
    await main.getByRole("button", { name: /^Change / }).first().click();
    await expect(page.getByRole("listbox", { name: "Model options" })).toBeVisible();
    await scan("model picker");
    await dismiss(page);
    // Every provider in the list, each opened on its own connection page.
    const add = page.getByRole("button", { name: "Add provider", exact: true });
    await add.click();
    await scan("add provider list");
    const providers = (await page.getByRole("option").allInnerTexts()).map((name) => name.trim()).filter(Boolean);
    await dismiss(page);
    expect(providers.length, "providers listed in Settings").toBeGreaterThan(5);
    for (const name of providers) {
      await add.click();
      await page.getByRole("option", { name, exact: true }).click();
      const connection = page.getByTestId("model-connection");
      await expect(connection).toBeVisible();
      await scan(`connect ${name}`);
      await connection.getByRole("button", { name: "Close", exact: true }).click();
      await expect(connection).toBeHidden();
    }
    await main.getByTestId("model-role-row-1").getByRole("button", { name: / options$/ }).click();
    await scan("model row menu");
    await page.getByRole("menuitem", { name: "Manage model", exact: true }).click();
    await expect(page.getByTestId("model-settings-page")).toBeVisible();
    await scan("model settings page");
  },
  async confirmations({ page, scan }) {
    await page.getByTestId("approval-rule-add").click();
    await scan("add approval rule");
    await dismiss(page);
  },
  async vault({ page, scan }) {
    await page.getByTestId("vault-new").click();
    await scan("new vault item");
    await dismiss(page);
    const importButton = page.getByTestId("vault-import");
    if (await importButton.isVisible().catch(() => false)) {
      await importButton.click();
      await scan("vault import");
    }
  },
  async organization({ page, scan }) {
    await page.getByRole("button", { name: "Create organization" }).click();
    await scan("create organization dialog");
    await dismiss(page);
  },
};

const SETTINGS: SettingsId[] = ["general", "models", "confirmations", "vault", "memory", "voice", "labs", "usage", "organization"];

export const settings: Surface[] = SETTINGS.map((id) => ({
  name: `settings / ${id}`,
  group: "settings",
  covers: [`settings:${id}`],
  async reach(ctx) {
    await openBot(ctx.page, ctx.world.chiefId, "Chief");
    await openUserSettings(ctx.page, id);
    await expect(ctx.page.getByTestId("user-settings")).toBeVisible();
    await ctx.scan("page");
    const panel = ctx.page.getByTestId("user-settings");
    await expandAll(ctx.page, panel);
    await openEachPopup(ctx.page, panel, ctx.scan, "dropdown");
    await extras[id]?.(ctx);
  },
}));

export function settingsPage(page: Page) {
  return page.getByTestId("user-settings");
}

/** Sections the deployment hides unless it reports a flag; the flags are faked in the browser to read their copy. */
export const hiddenSections: Surface = {
  name: "settings: sections this deployment hides (flags faked in the browser)",
  group: "settings",
  covers: ["settings:wallet", "settings:messaging", "settings:computer", "settings:billing"],
  async reach({ page, world, scan, note }) {
    const patch = (change: (body: { json?: Record<string, unknown> }) => void) => async (route: import("@playwright/test").Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: Record<string, unknown> };
      change(body);
      await route.fulfill({ response, json: body });
    };
    await page.route(
      "**/rpc/bootstrap",
      patch((body) => {
        const me = body.json?.me as Record<string, unknown> | undefined;
        if (me) Object.assign(me, { billingEnabled: true, paymentWalletProvider: { id: "e2e", name: "E2E wallet" }, computerSettingsEnabled: true, isAdmin: true });
      }),
    );
    await page.route("**/rpc/messaging/status", patch((body) => void (body.json && (body.json.enabled = true))));
    await openBot(page, world.chiefId, "Chief");
    for (const id of ["wallet", "messaging", "computer", "billing"] as const) {
      await openUserSettings(page, id);
      await scan(`section ${id}`);
    }
    note("flags faked client-side (billing, wallet, messaging, computer, admin); the api refuses the data calls with 4xx, so only the pages' own copy is scanned");
  },
};
