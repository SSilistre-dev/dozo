import type { Page } from "@playwright/test";
import { expect, readWorld, rpc, test, UPSTREAM_AVATAR_ART } from "./fixtures";
import { gotoStable, openAccountMenu, openBot, openBotSettings, openUserSettings } from "./ui";

// The Dozo look on the screens the design mockups cover (dozo/design, the chat window from
// chat-v2.html), in both themes. Each check
// reads a hook the fork's stylesheet or avatar wrapper relies on (a data attribute or a class of
// upstream's), so an upstream merge that renames one fails here instead of silently dropping the look.

const INNER = '[data-slot="sidebar-inner"]';
const HEADER = `${INNER} > .app-drag:first-child`;
const ROW = "[data-roster-bot-id]";
const CLEAR = "rgba(0, 0, 0, 0)";

/** A computed style value of the first match, or of one of its pseudo-elements. */
function styleOf(page: Page, selector: string, property: string, pseudo?: string) {
  return page.evaluate(
    ([sel, prop, pse]) => {
      const element = document.querySelector(sel as string);
      if (!element) throw new Error(`no element matches ${sel}`);
      return getComputedStyle(element, pse ?? undefined).getPropertyValue(prop as string);
    },
    [selector, property, pseudo ?? null],
  );
}

/** A theme token as the browser resolves it to a computed colour. */
function tokenColor(page: Page, token: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

test("the theme file is loaded and follows the chosen appearance", async ({ page, theme }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const response = await page.request.get("/instance-theme.css");
  expect(response.ok(), `instance theme answered ${response.status()}`).toBe(true);
  const block = (await response.text()).match(
    new RegExp(`html\\[data-theme="${theme}"\\] \\{([^}]*)\\}`),
  )?.[1];
  const declared = block?.match(/--background: (#[0-9a-f]+);/i)?.[1];
  expect(declared, `the theme sets no ${theme} background`).toBeTruthy();
  const applied = (await styleOf(page, "html", "--background")).trim();
  expect(applied.toLowerCase()).toBe(declared?.toLowerCase());
});

test("the sidebar shows Dozo characters in two-line rows under the wordmark and the pattern", async ({
  page,
}) => {
  const world = readWorld();
  await openBot(page, world.chiefId, "Chief");
  const rows = page.locator(ROW);
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(`${ROW} > .dozo-avatar`)).toHaveCount(await rows.count());
  await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);

  // Two-line rows (name, then the last message) with the large avatar, softly rounded; buttons
  // stay fully rounded.
  await expect(page.locator(`${ROW} [data-roster-preview]`).first()).toBeVisible();
  expect(await styleOf(page, ROW, "border-radius")).toBe("12px");
  expect(await styleOf(page, `${ROW} > .dozo-avatar`, "width")).toBe("38px");
  expect(await styleOf(page, `${ROW} > .dozo-avatar`, "scale")).not.toBe("none");
  expect(await styleOf(page, `${INNER} [data-slot="button"]`, "border-radius")).toBe("999px");
  expect(await styleOf(page, '[data-testid="create-menu-trigger"]', "width")).toBe("40px");

  // The wordmark with its seal dot starts the header (a browser has no window controls, so their
  // spacer is dropped), and the wave pattern lies behind the top of the sidebar.
  expect((await page.getByTestId("bots-sidebar").boundingBox())?.width).toBe(288);
  expect(await styleOf(page, `${HEADER} > [aria-hidden="true"]`, "display")).toBe("none");
  expect(await styleOf(page, HEADER, "content", "::before")).toBe('"dozo"');
  expect(await styleOf(page, HEADER, "background-image", "::before")).toContain("radial-gradient");
  expect(await styleOf(page, INNER, "mask-image", "::before")).toContain("data:image/svg+xml");
  expect(await styleOf(page, INNER, "opacity", "::before")).toBe("1");

  // The open chat's row is one tone lighter than the sidebar; the others are not filled.
  const open = `${ROW}[aria-current="page"]`;
  await expect(page.locator(open)).toHaveCount(1);
  const sidebar = await styleOf(page, INNER, "background-color");
  const on = await styleOf(page, open, "background-color");
  expect(on).not.toBe(CLEAR);
  expect(on).not.toBe(sidebar);
  expect(await styleOf(page, `${ROW}:not([aria-current])`, "background-color")).toBe(CLEAR);
  expect(await styleOf(page, `${open} > .dozo-avatar`, "content", "::before")).toBe("none");
});

test("the collapsed sidebar stacks four equal buttons above the bots, without overlap", async ({
  page,
}) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const header = page.locator(HEADER);
  await header.hover();
  await page.getByTestId("minimize-bots-sidebar").click();
  const restore = page.getByTestId("restore-bots-sidebar");
  await expect(restore).toBeVisible();
  try {
    // At rest: the pointer is over the thread, not the strip.
    await page.mouse.move(900, 450);
    const sidebar = page.getByTestId("bots-sidebar");
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(72);
    const strip = await sidebar.boundingBox();
    const buttons = [
      page.getByTestId("sidebar-search-trigger"),
      header.locator("[data-activity-mode]"),
      restore,
      page.getByTestId("create-menu-trigger"),
    ];
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
    expect(new Set(boxes.map((box) => box?.x))).toEqual(new Set([(strip?.x ?? 0) + 16]));
    const sizes = new Set(boxes.map((box) => `${box?.width}x${box?.height}`));
    expect([...sizes]).toEqual(["40x40"]);
    const gaps = new Set(
      boxes.slice(1).map((box, i) => Math.round((box?.y ?? 0) - ((boxes[i]?.y ?? 0) + 40))),
    );
    expect(gaps.size).toBe(1);

    // The bots start below the last button, with room between, and centred in the strip.
    const create = boxes[3];
    const first = await page.locator(ROW).first().boundingBox();
    expect(first?.y ?? 0).toBeGreaterThan((create?.y ?? 0) + (create?.height ?? 0));
    expect((first?.x ?? 0) + (first?.width ?? 0) / 2).toBe((strip?.x ?? 0) + 36);

    // The open chat's avatar stands on a lighter round surface; the wave pattern is not cut.
    const open = `${ROW}[aria-current="page"]`;
    expect(await styleOf(page, open, "background-color")).not.toBe(
      await styleOf(page, INNER, "background-color"),
    );
    expect(await styleOf(page, open, "border-radius")).toBe("50%");
    expect(await styleOf(page, INNER, "opacity", "::before")).toBe("0");
  } finally {
    await restore.click();
    await expect(page.getByTestId("minimize-bots-sidebar")).toBeAttached();
  }
});

test("the chat is a narrow column of tonal bubbles with a one-pill composer in the bot's colour", async ({
  page,
}) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const bubble = page.getByTestId("message-bot-bubble").first();
  await expect(bubble).toBeVisible();
  expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(CLEAR);
  await expect(bubble).toHaveCSS("border-radius", "18px");
  await expect(bubble).toHaveCSS("padding-left", "14px");
  const bar = page.getByTestId("composer-bar");
  await expect(bar).toHaveCSS("border-radius", "22px");
  await expect(bar).toHaveCSS("border-top-width", "0px");
  const column = (await bar.boundingBox())?.width ?? 0;
  expect(column).toBeGreaterThan(400);
  expect(column).toBeLessThanOrEqual(680);
  // What scrolls under the floating name pill fades out at the column's top edge.
  expect(await styleOf(page, '[data-testid="transcript"]', "mask-image")).toContain(
    "linear-gradient",
  );
  expect(await styleOf(page, '[data-testid="transcript"]', "padding-left")).toBe(
    await styleOf(page, 'fieldset:has(> [data-testid="composer-bar"])', "padding-left"),
  );

  // The send button wears the bot's identity colour, one value per theme, as your bubbles do.
  const draft = page.getByRole("combobox", { name: "Message Chief" });
  await draft.fill("hello");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  expect(await send.getAttribute("class")).toContain("bg-chat-user");
  expect(await send.getAttribute("style")).toContain("light-dark(");
  await draft.fill("");
});

test("the chat header and the bot panel show the bot's character", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const trigger = page.getByTestId("bot-settings-trigger");
  await expect(trigger.locator(".dozo-avatar")).toBeVisible();
  await expect(trigger).toHaveCSS("height", "39px");
  expect(await styleOf(page, '[data-testid="bot-settings-trigger"]', "content", "::after")).toBe(
    '""',
  );
  await trigger.click();
  const profile = page.getByTestId("bot-profile-header");
  await expect(profile.locator(".dozo-avatar").first()).toBeVisible();
  await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);
  // The panel stands on the sidebar's tone.
  await expect(page.getByTestId("side-panel")).toHaveCSS(
    "background-color",
    await tokenColor(page, "--sidebar"),
  );
});

test("tables, files and questions in the thread share the card surface", async ({ page }) => {
  // A bot of its own: the question it asks leaves it waiting, which no other check should see.
  const name = `Cards ${Math.random().toString(36).slice(2, 7)}`;
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  try {
    await openBot(page, bot.id, name);
    const composer = page.getByRole("combobox", { name: `Message ${name}` });
    const card = await tokenColor(page, "--card");
    await composer.fill("Open tickets [e2e-table]");
    await composer.press("Enter");
    const table = page.getByTestId("table-card").first();
    await expect(table).toBeVisible({ timeout: 60_000 });
    await expect(table).toHaveCSS("background-color", card);
    await expect(table).toHaveCSS("border-radius", "20px");
    await expect(table).toHaveCSS("border-top-width", "0px");

    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "list.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("topic,open\nBilling,3\n"),
      });
    await composer.fill("The list");
    await composer.press("Enter");
    const file = page.getByRole("button", { name: "Preview list.csv" }).locator("..");
    await expect(file).toBeVisible({ timeout: 30_000 });
    await expect(file).toHaveCSS("background-color", card);
    await expect(file).toHaveCSS("border-radius", "22px");
    await expect(page.getByRole("button", { name: "Download list.csv" })).toHaveCSS(
      "border-left-width",
      "0px",
    );

    const args = Buffer.from(
      JSON.stringify({ question: "Reply now?", options: ["Yes", "Not now"] }),
    ).toString("base64");
    await composer.fill(`Ask me [e2e-tool:ask_user b64:${args}]`);
    await composer.press("Enter");
    const question = page.getByTestId("question-card");
    await expect(question).toBeVisible({ timeout: 60_000 });
    await expect(question).toHaveCSS("background-color", card);
    const choice = question.getByRole("button", { name: "Not now" });
    await expect(choice).toHaveCSS("border-radius", "14px");
    expect(await choice.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(CLEAR);
    await expect(choice.locator("span[aria-hidden]").first()).toBeHidden();
  } finally {
    await rpc(page, "bots/remove", { botId: bot.id, deleteMemories: true });
  }
});

test("settings sit on one tonal sheet with the nav in three groups", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const settings = await openUserSettings(page);
  await expect(settings).toHaveCSS("border-radius", "14px");
  await expect(settings).toHaveCSS("background-color", await tokenColor(page, "--background"));
  const groups = settings.locator("[data-dozo-settings-group]");
  expect(await groups.count()).toBeGreaterThanOrEqual(2);
  await expect(settings.getByRole("group", { name: "Account" })).toContainText("General");
  await expect(settings.getByRole("group", { name: "Bots" })).toContainText("Models");
  const current = settings.getByTestId("settings-nav-general");
  await expect(current).toHaveAttribute("aria-current", "page");
  expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(CLEAR);
  await expect(settings.getByTestId("settings-nav")).toHaveCSS("border-right-width", "0px");
  await expect(settings.getByTestId("settings-header")).toHaveCSS("border-bottom-width", "0px");
  const group = settings.locator("section > .divide-y.border").first();
  await expect(group).toHaveCSS("border-top-width", "0px");
  await expect(group).toHaveCSS("border-radius", "14px");
});

test("menus share one surface and a destructive item is a red word", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const popover = await tokenColor(page, "--popover");
  const account = await openAccountMenu(page);
  await expect(account).toHaveCSS("border-radius", "16px");
  await expect(account).toHaveCSS("background-color", popover);
  // The edge is an outline, drawn over the content; the separator is a half-pixel line.
  await expect(account).toHaveCSS("outline-style", "solid");
  const separator = account.locator("> .border-t").first();
  await expect(separator).toHaveCSS(
    "border-top-color",
    await tokenColor(page, "--dozo-wash-strong"),
  );
  await page.keyboard.press("Escape");

  await page.locator(`${ROW}[aria-current="page"]`).click({ button: "right" });
  const menu = page.locator('[data-slot="context-menu-content"]').first();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("border-radius", "16px");
  await expect(menu).toHaveCSS("background-color", popover);
  const remove = menu.locator('[data-variant="destructive"]').first();
  await remove.hover();
  // Washed like any item where the pointer is, never a red panel; the word is the red.
  await expect(remove).toHaveCSS("background-color", await tokenColor(page, "--dozo-wash"));
  await expect(remove).toHaveCSS("color", await tokenColor(page, "--dozo-danger-text"));
  await expect(
    menu.locator('[data-slot="context-menu-item"] > svg:first-child').first(),
  ).toBeHidden();
  await page.keyboard.press("Escape");

  // Reached by keyboard, an item gets a stronger wash and an inner ring, not just the hover wash.
  await page.locator(`${ROW}[aria-current="page"]`).click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const keyed = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const cs = getComputedStyle(el);
    return { slot: el.dataset.slot ?? "", bg: cs.backgroundColor, ring: cs.boxShadow };
  });
  expect(keyed.slot).toMatch(/^context-menu-(item|sub-trigger)$/);
  expect(keyed.bg).toBe(await tokenColor(page, "--dozo-wash-strong"));
  expect(keyed.ring).toContain("inset");

  // The delete confirmation: one tonal sheet, footer without a line; cancelled, nothing deleted.
  await remove.click();
  const dialog = page.locator('[data-slot="alert-dialog-content"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("border-radius", "14px");
  await expect(dialog).toHaveCSS("box-shadow", "none");
  await expect(dialog.locator('[data-slot="alert-dialog-footer"]')).toHaveCSS(
    "border-top-width",
    "0px",
  );
  // The destructive button is the red word (a check on the computed colour, not on a class).
  const confirm = dialog.locator('[data-slot="alert-dialog-action"]').last();
  await expect(confirm).toHaveCSS("color", await tokenColor(page, "--dozo-danger-text"));
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  // Cancelled: the bot is still there.
  await expect(page.locator(`${ROW}[data-roster-bot-id="${readWorld().chiefId}"]`)).toHaveCount(1);
  expect(
    (await rpc<{ id: string }[]>(page, "bots/list", {})).some(
      (bot) => bot.id === readWorld().chiefId,
    ),
  ).toBe(true);
});

/** Tabs until the focused element matches `selector`, at most 40 stops. */
async function tabTo(page: Page, selector: string) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) {
      return;
    }
  }
  throw new Error(`no focus stop matches ${selector}`);
}

test("keyboard focus and errors stay visible in the quiet controls", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const settings = await openUserSettings(page);
  const focusRing = async () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as HTMLElement);
      return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
    });
  // A field (the language picker) and a button (Edit), reached with Tab.
  // Upstream's controls transition every property, so the ring is read once it has settled.
  const ring = `solid 2px ${await tokenColor(page, "--dozo-focus")}`;
  await tabTo(page, '[data-slot="select-trigger"]');
  await expect.poll(focusRing).toBe(ring);
  await tabTo(page, '[data-slot="switch"]');
  await expect.poll(focusRing).toBe(ring);

  // A field the app marks invalid is drawn in the destructive colour.
  await settings.getByRole("button", { name: "Edit" }).first().click();
  const field = settings.locator('[data-slot="input"]').first();
  await expect(field).toBeVisible();
  await field.evaluate((el) => el.setAttribute("aria-invalid", "true"));
  expect(await field.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(
    await tokenColor(page, "--destructive"),
  );
  await page.keyboard.press("Escape");
});

test("a selected option keeps the room upstream leaves for its tick", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  const settings = await openUserSettings(page);
  await settings.locator('[data-slot="select-trigger"]').first().click();
  const item = page.locator('[data-slot="select-item"][data-selected]').first();
  await expect(item).toBeVisible();
  await expect(item).toHaveCSS("padding-right", "32px");
  const boxes = await item.evaluate((el) => {
    const tick = el.querySelector("span.absolute")?.getBoundingClientRect();
    const words = [...el.querySelectorAll("*"), el]
      .flatMap((node) => [...node.childNodes])
      .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    const range = document.createRange();
    if (words) range.selectNodeContents(words);
    const text = range.getBoundingClientRect();
    return { textEnd: text.right, tickStart: tick?.left ?? Number.POSITIVE_INFINITY };
  });
  expect(boxes.textEnd).toBeLessThanOrEqual(boxes.tickStart);
  await page.keyboard.press("Escape");
});

test("full-screen dialogs and ones with their own corners keep upstream's shape", async ({
  page,
}) => {
  await openBot(page, readWorld().chiefId, "Chief");
  // The classes upstream gives the plan wall, a peer conversation, and a dialog with its own
  // corners, on a dialog element: none of them is turned into the 14px tonal sheet.
  const shapes = await page.evaluate(() => {
    const measure = (cls: string, slot = true) => {
      const el = document.createElement("div");
      if (slot) el.setAttribute("data-slot", "dialog-content");
      el.className = cls;
      document.body.append(el);
      const cs = getComputedStyle(el);
      const out = { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor };
      el.remove();
      return out;
    };
    return {
      wall: measure("fixed inset-0 h-dvh rounded-none bg-background p-0 ring-0"),
      peer: measure("inset-0 flex h-full w-full rounded-none bg-background p-0 ring-0"),
      own: measure("rounded-2xl bg-card"),
      ownPlain: measure("rounded-2xl bg-card", false),
      plain: measure("bg-background", false),
    };
  });
  expect(shapes.wall).toEqual({ radius: "0px", bg: shapes.plain.bg });
  expect(shapes.peer).toEqual({ radius: "0px", bg: shapes.plain.bg });
  expect(shapes.own).toEqual(shapes.ownPlain);
});

test("a popover filled edge to edge keeps its edge (the model picker)", async ({ page }) => {
  await openBot(page, readWorld().chiefId, "Chief");
  await openBotSettings(page);
  await page
    .getByTestId("side-panel")
    .getByRole("button", { name: /^Model/ })
    .first()
    .click();
  const picker = page.locator('[data-slot="popover-content"]').last();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("outline-style", "solid");
  await expect(picker).toHaveCSS("outline-color", await tokenColor(page, "--dozo-menu-edge"));
  await page.keyboard.press("Escape");
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the mark above sign-in is the Dozo logo, not a bot", async ({ page }) => {
    await gotoStable(page, "/sign-in");
    const logo = page.locator("svg.dozo-logo");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute("aria-label", "Dozo");
    expect((await logo.boundingBox())?.height).toBe(44);
    await expect(page.locator(".dozo-avatar")).toHaveCount(0);
    await expect(page.locator(UPSTREAM_AVATAR_ART)).toHaveCount(0);
    await expect(page.locator('[data-slot="button"]').first()).toHaveCSS("border-radius", "999px");
  });

  test("sign-up is offered while the server takes new accounts, as it does here", async ({
    page,
  }) => {
    const capabilities = await (await page.request.get("/api/auth/capabilities")).json();
    expect(capabilities.signupsOpen).toBe(true);
    await gotoStable(page, "/sign-in");
    await expect(page.locator('a[href^="/sign-up"]')).toBeVisible();
    await page.goto("/sign-up");
    await expect(page.locator('a[href^="/sign-in"]')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up/);
  });

  test("a server that takes no new accounts shows sign-in only, at every door", async ({
    page,
  }) => {
    await page.route("**/api/auth/capabilities", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), signupsOpen: false } });
    });
    await gotoStable(page, "/sign-in");
    await expect(page.locator("svg.dozo-logo")).toBeVisible();
    await expect(page.locator('[data-dozo-signups="closed"]')).toHaveCount(1);
    await expect(page.locator('a[href^="/sign-up"]')).toBeHidden();
    for (const door of ["/sign-up", "/sign-up/email", "/"]) {
      await page.goto(door);
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(page.locator('[data-dozo-signups="closed"]')).toHaveCount(1);
      await expect(page.locator('a[href^="/sign-up"]')).toBeHidden();
    }
  });

  test("a first visit with no stored choice is dark, even on a light system", async ({
    browser,
    theme,
  }, testInfo) => {
    test.skip(theme !== "light", "does not depend on the project's theme");
    // A context of its own: the suite's fixture stores an appearance before the page loads.
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await gotoStable(page, "/sign-in");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("svg.dozo-logo")).toBeVisible();
    await context.close();
  });
});
