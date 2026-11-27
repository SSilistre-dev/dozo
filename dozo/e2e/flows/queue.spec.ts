import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { Theme } from "../fixtures";
import { APPEARANCE_KEY } from "../fixtures";
import { outDir } from "../scan";
import { connectModelThroughOnboarding } from "../support";
import { openBot } from "../ui";
import { newAccount, rpcAs } from "./accounts";
import { expect, test } from "./flow";

type Item = {
  id: string;
  kind: "run" | "message";
  botId: string;
  position: number;
  mine: boolean;
  reason: "bot_busy" | "computer_busy" | "behind_run";
  waitingFor?: string | null;
  label?: string | null;
};

/** The same call as `rpcAs`, made inside another Space of the account (the Space header). */
async function rpcIn<T>(page: Page, spaceId: string, procedure: string, body: unknown) {
  const response = await page.request.post(`/rpc/${procedure}`, {
    data: { json: body },
    headers: { "x-rakazo-space-id": spaceId },
  });
  const parsed = (await response.json()) as { json?: T };
  expect(
    response.ok(),
    `${procedure} answered ${response.status()} ${JSON.stringify(parsed).slice(0, 300)}`,
  ).toBe(true);
  return parsed.json as T;
}

async function shoot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({ path: `${outDir()}/shots/${name}.png` });
}

/** Closes the list by clicking an empty part of the chat. */
async function closeList(page: Page) {
  await page.mouse.click(1100, 650);
  await expect(page.locator("[data-row]")).toHaveCount(0);
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [APPEARANCE_KEY, theme]);
  await page.reload();
}

type Routine = { id: string };
type RunRow = { botId: string; status: string };
type Started = { runId: string };

/**
 * A bot that is busy with one long answer a member asked for, and the work that waits behind it
 * (routines that post in the chat wait for it; one that runs beside the chat never does):
 * the caller's two routine runs and a message of its own, and the member's routine run and
 * message. The list shows the caller's own words only, the caller can stop its own wait and
 * nothing else, and the line follows the Space's live signal: no reload and no timed re-read.
 */
test("queue: waiting work is listed, the caller's own wait can be stopped, and the line follows live", async ({
  page,
  browser,
  guard,
}) => {
  test.setTimeout(420_000);
  const name = `Queuebot ${Math.random().toString(36).slice(2, 7)}`;
  const bot = await rpcAs<{ id: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const nav = await rpcAs<{ current: { id: string } }>(page, "spaces/list");
  const spaceId = nav.current.id;
  const invite = await rpcAs<{ url: string }>(page, "spaces/invites/create", { spaceId });
  const member = await newAccount(browser, "queue-member");
  guard.follow(page);
  // A member runs on a model of their own.
  await connectModelThroughOnboarding(member.page);
  await rpcAs(member.page, "spaces/invites/accept", { token: invite.url.split("/").pop() });
  const mine = <T = unknown>(procedure: string, body: unknown) =>
    rpcIn<T>(page, spaceId, procedure, body);
  const theirs = <T = unknown>(procedure: string, body: unknown) =>
    rpcIn<T>(member.page, spaceId, procedure, body);
  const target = { botId: bot.id };
  const list = async () => (await mine<{ items: Item[] }>("dozoQueue/list", target)).items;
  const statusOf = async (routineId: string, runId: string) =>
    (
      await mine<{ runs: Array<{ id: string; status: string }> }>("routines/history", { routineId })
    ).runs.find((run) => run.id === runId)?.status;
  const secret = "Member secret routine";
  const secretWords = "The member's private words";

  // The member's long answer keeps the bot busy.
  await theirs("threads/send", { ...target, text: "Keep the bot busy [e2e-slow:200]" });
  await expect
    .poll(async () => {
      const rows = (await theirs<{ runs: RunRow[] }>("runs/list", { filter: "active" })).runs;
      return rows.some((run) => run.botId === bot.id && run.status === "running");
    })
    .toBe(true);
  expect(await list(), "nothing waits while the first job is the one running").toEqual([]);

  // Work in line behind it, in the order it was made: the caller's two routine runs around the
  // member's routine run, then a message of each.
  const digest = await mine<Routine>("routines/create", {
    botId: bot.id,
    name: "Weekly digest",
    prompt: "Summarize the week",
    crons: ["0 9 * * 1"],
    inChat: true,
  });
  const other = await theirs<Routine>("routines/create", {
    botId: bot.id,
    name: secret,
    prompt: "Summarize the week",
    crons: ["0 9 * * 1"],
    inChat: true,
  });
  const first = await mine<Started>("routines/testRun", { routineId: digest.id });
  const theirRun = await theirs<Started>("routines/testRun", { routineId: other.id });
  const second = await mine<Started>("routines/testRun", { routineId: digest.id });
  await mine("threads/send", { ...target, text: "A thought of my own" });
  await theirs("threads/send", { ...target, text: secretWords });

  let items: Item[] = [];
  await expect
    .poll(
      async () => {
        items = await list();
        return items.length;
      },
      { timeout: 60_000 },
    )
    .toBe(4);
  console.log(`QUEUE-LIST ${JSON.stringify(items)}`);
  const order = items.map((item) => item.id);
  expect(order.slice(0, 3), "queued runs in the order they were made").toEqual([
    first.runId,
    theirRun.runId,
    second.runId,
  ]);
  expect(items.map((item) => item.position)).toEqual([1, 2, 3, 4]);
  expect(items.map((item) => item.reason)).toEqual([
    "bot_busy",
    "bot_busy",
    "bot_busy",
    "behind_run",
  ]);
  const theirItems = items.filter((item) => !item.mine);
  expect(theirItems).toHaveLength(1);
  for (const item of theirItems) expect(item.label ?? null).toBeNull();
  expect(JSON.stringify(items)).not.toContain(secret);
  expect(JSON.stringify(items)).not.toContain("private words");
  expect(items.find((item) => item.id === first.runId)?.label).toBe("Weekly digest");
  // The caller's own message held behind the member's run shows its own first words.
  expect(items[3]).toMatchObject({ kind: "message", mine: true, label: "A thought of my own" });

  // The caller's page: the line, the place, the list.
  await openBot(page, bot.id, name);
  await page.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });
  // The flows project does not set a theme (a first visit is dark): light first, then dark.
  await setTheme(page, "light");
  const line = page.getByText(/Waiting in line…/);
  await expect(line).toBeVisible({ timeout: 30_000 });
  await expect(line).toContainText("#1");
  const trigger = line.locator("xpath=ancestor-or-self::button[1]");
  await trigger.click();
  const rows = page.locator("[data-row]");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Weekly digest");
  await expect(rows.nth(1)).toContainText("Queued");
  await expect(rows.nth(1)).not.toContainText(secret);
  await expect(rows.nth(1).getByRole("button", { name: "Stop" })).toHaveCount(0);
  // The chat itself shows the member's words (it is their shared chat); the list never does.
  const listed = (await rows.allTextContents()).join(" | ");
  console.log(`QUEUE-ROWS ${listed}`);
  expect(listed).not.toContain(secret);
  expect(listed).not.toContain("private words");
  await page.waitForTimeout(500);
  await shoot(page, "app-queue-list-light");
  await closeList(page);
  await shoot(page, "app-queue-chat-light");
  await setTheme(page, "dark");
  await expect(line).toBeVisible({ timeout: 30_000 });
  await shoot(page, "app-queue-chat-dark");
  await trigger.click();
  await expect(rows).toHaveCount(4);
  await page.waitForTimeout(500);
  await shoot(page, "app-queue-list-dark");
  await closeList(page);
  await page.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });

  // Another person's work cannot be stopped: not found, and it stays in line.
  const refused = await page.request.post("/rpc/dozoQueue/cancelWaiting", {
    data: { json: { runId: theirRun.runId } },
    headers: { "x-rakazo-space-id": spaceId },
  });
  console.log(`QUEUE-CANCEL-OTHERS status=${refused.status()}`);
  expect(refused.status()).toBe(404);
  expect(await statusOf(other.id, theirRun.runId)).toBe("queued");

  // Live: the caller's first wait is stopped from another client; this page is not reloaded and
  // no timer reads the queue again, yet its place moves from #1 to the next one's.
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/dozoQueue/list")) reads += 1;
  });
  const before = reads;
  await mine("dozoQueue/cancelWaiting", { runId: first.runId });
  await expect(page.getByText(/Waiting in line…/).first()).toContainText("#2", { timeout: 30_000 });
  expect(await statusOf(digest.id, first.runId)).toBe("cancelled");
  await trigger.click();
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  console.log(`QUEUE-LIVE-CANCEL list reads after the signal: ${reads - before}`);
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  expect(await statusOf(other.id, theirRun.runId)).toBe("queued");
  const afterCancel = await list();
  expect(afterCancel.map((item) => item.position)).toEqual([1, 2, 3]);
  expect(afterCancel.some((item) => item.id === first.runId)).toBe(false);
  // The job under way was not touched.
  const active = (await theirs<{ runs: RunRow[] }>("runs/list", { filter: "active" })).runs;
  expect(active.some((run) => run.botId === bot.id && run.status === "running")).toBe(true);

  // Stopping the second wait from its own row in the list.
  const own = rows.filter({ hasText: "Weekly digest" });
  await own.getByRole("button", { name: "Stop" }).click();
  await expect
    .poll(async () => statusOf(digest.id, second.runId), { timeout: 30_000 })
    .toBe("cancelled");
  await expect(page.getByText(/Waiting in line…/).first()).toBeVisible();
  console.log(`QUEUE-UI-CANCEL ${JSON.stringify(await list())}`);

  // The reads stop with the signals: nothing reads the queue again while the page sits idle.
  const idle = reads;
  await page.waitForTimeout(8_000);
  console.log(`QUEUE-IDLE list reads in 8 s idle: ${reads - idle}`);
  expect(reads - idle).toBe(0);

  // The first job ends (stopped): the line follows without a reload and its work starts.
  await theirs("threads/stop", target);
  await expect.poll(async () => (await list()).length, { timeout: 90_000 }).toBeLessThan(2);
  await expect(page.getByText(/Waiting in line…/)).toHaveCount(0, { timeout: 30_000 });
  console.log(`QUEUE-AFTER-END ${JSON.stringify(await list())}`);
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
});
