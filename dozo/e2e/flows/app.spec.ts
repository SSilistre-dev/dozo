import { readWorld } from "../fixtures";
import { openBot, openBotPanel, openUserSettings } from "../ui";
import { newAccount, rpcAs } from "./accounts";
import { expect, test } from "./flow";

/**
 * What a signed-in person does every day, as the account the setup project made (English UI, the
 * offline model connected). Each test ends where its screenshot shows the result.
 */

test("onboarding: the model step's 'Later' opens the app with the first bot", async ({
  browser,
  guard,
}) => {
  const { page } = await newAccount(browser, "later");
  guard.follow(page);
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("button", { name: "Later" }).click();
  await page.waitForURL(/\/app\/[^/?]+/);
  await expect(page.getByRole("button", { name: "Connect apps" })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
});

test("chat: a message gets the model's reply; a tool call waits for approval and runs once approved", async ({
  page,
}) => {
  // A bot of its own, so renaming it touches nothing another scenario reads.
  const name = `Toolbot ${Math.random().toString(36).slice(2, 7)}`;
  const bot = await rpcAs<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  // Ask before anything that changes something; put the account's choice back afterwards.
  const before = await rpcAs<{ enabled: boolean; skipApprovals: boolean }>(
    page,
    "autoReview/get",
    {},
  );
  await rpcAs(page, "autoReview/set", { mode: "ask" });
  try {
    await openBot(page, bot.id, name);
    const composer = page.getByRole("combobox", { name: `Message ${name}` });
    const replies = page.getByTestId("message-bot-bubble");
    const count = await replies.count();
    await composer.fill("Hello");
    await composer.press("Enter");
    await expect(replies).toHaveCount(count + 1, { timeout: 60_000 });
    await expect(replies.last()).toContainText("Hello from the offline Dozo test model.");
    // The stub calls web_fetch on a site the owner never named (its address travels in base64), so
    // the owner is asked first. A reserved name that never resolves: nothing is fetched.
    const args = Buffer.from('{"url":"https://dozo-e2e.invalid/"}').toString("base64");
    await composer.fill(`Read the page [e2e-tool:web_fetch b64:${args}]`);
    await composer.press("Enter");
    const allow = page.getByRole("button", { name: /^Allow/ }).first();
    await expect(allow).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("The offline test model saw the tool finish.")).toHaveCount(0);
    await allow.click();
    // The tool ran (and could not reach the address); the model saw its result.
    await expect(page.getByText("The offline test model saw the tool finish.").last()).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await rpcAs(page, "autoReview/set", {
      enabled: before.enabled,
      skipApprovals: before.skipApprovals,
    });
  }
});

test("bots: create, rename, delete", async ({ page }) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  const name = `Temp ${Math.random().toString(36).slice(2, 7)}`;
  await page
    .getByTestId("create-menu-trigger")
    .or(page.getByRole("button", { name: "Create" }))
    .first()
    .click();
  await page.getByTestId("create-new-bot").click();
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  // Rename in the bot panel.
  await openBotPanel(page);
  await page.getByRole("button", { name: "Edit name" }).click();
  const renamed = `${name} R`;
  const input = page.getByTestId("bot-settings").getByRole("textbox").first();
  await input.fill(renamed);
  await input.press("Enter");
  await expect(page.getByPlaceholder(`Message ${renamed}`)).toBeVisible();
  // Delete from the sidebar's menu for that bot.
  const deleted = new URL(page.url()).pathname;
  const row = page.getByRole("button", { name: new RegExp(`^${renamed}`) }).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${renamed}`) })).toHaveCount(0);
  // The app has moved on to another chat: the reads the deletion set off have run by now, and
  // none of them asked for the deleted bot.
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(deleted);
  await expect(page.getByRole("combobox", { name: /^Message / })).toBeVisible();
});

test("scheduled task: create in the bot panel, then delete", async ({ page }) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  await openBotPanel(page);
  const title = `E2E routine ${Math.random().toString(36).slice(2, 7)}`;
  await page.getByTestId("routine-create-button").click();
  await page.getByPlaceholder("Name this routine").fill(title);
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every day", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Saved: the editor now offers to delete it, and the bot's list has it.
  const remove = page.getByRole("button", { name: "Delete", exact: true });
  await expect(remove).toBeVisible();
  await expect
    .poll(async () =>
      (await rpcAs<{ name: string }[]>(page, "routines/list", { botId: world.chiefId })).map(
        (r) => r.name,
      ),
    )
    .toContain(title);
  await remove.click();
  const confirm = page.getByRole("alertdialog");
  await expect(async () => {
    if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Delete" }).click();
    const names = (
      await rpcAs<{ name: string }[]>(page, "routines/list", { botId: world.chiefId })
    ).map((r) => r.name);
    expect(names).not.toContain(title);
  }).toPass();
});

test("Apps: the integrations window opens, switches category, every logo loads", async ({
  page,
}) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  await page.getByRole("button", { name: "Connect apps" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Add", exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Communication", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add", exact: true }).first()).toBeVisible();
  const logos = dialog.locator("img");
  await expect
    .poll(() =>
      logos.evaluateAll(
        (all) =>
          // The tiles in view; the rest load lazily as the list scrolls.
          all.filter((img) => {
            const box = img.getBoundingClientRect();
            const shown = box.bottom > 0 && box.top < window.innerHeight;
            return shown && !(img as HTMLImageElement).complete;
          }).length,
      ),
    )
    .toBe(0);
  const broken = await logos.evaluateAll((all) =>
    all
      .filter((img) => {
        const box = img.getBoundingClientRect();
        const shown = box.bottom > 0 && box.top < window.innerHeight;
        return shown && (img as HTMLImageElement).naturalWidth === 0;
      })
      .map((img) => (img as HTMLImageElement).src),
  );
  expect(broken, "logos that did not load").toEqual([]);
});

const SECTIONS = [
  "general",
  "models",
  "confirmations",
  "vault",
  "memory",
  "voice",
  "labs",
  "usage",
  "organization",
] as const;

test("settings: every section opens without an error", async ({ page }) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  for (const id of SECTIONS) {
    const panel = await openUserSettings(page, id);
    await expect(panel.locator(`[data-settings-section="${id}"]`).or(panel).first()).toBeVisible();
    await expect(page.locator('[data-rakazo-app-state="failed"]')).toHaveCount(0);
  }
});

test("404: an unknown address, signed in", async ({ page }) => {
  await page.goto("/no-such-page-e2e");
  await expect(page.getByText("Page not found")).toBeVisible();
});
