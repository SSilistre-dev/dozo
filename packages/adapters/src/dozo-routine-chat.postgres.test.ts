import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DOZO_ROUTINE_CATCH_UP_MS, saveDozoQuietHours } from "./dozo-quiet-hours.js";
import { dozoRoutineChatNote } from "./dozo-routine-chat.js";
import { dozoSendLimitGate } from "./dozo-send-limit.js";
import { dozoCreateSchedule } from "./dozo-wait.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { RunContext } from "./run-context.js";
import { retryRoutineRun, wakeRoutine } from "./run-routines.js";
import type { ScheduleToolDeps } from "./schedule-tools.js";
import { createScheduleFromTool } from "./schedule-tools.js";

// Runs on the branded tree only, against a migrated database (dozo/docker/postgres-tests.sh, in
// UTC and two other database time zones). The fork's unit gate has no database and skips it.
const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WATCH = { kind: "http", url: "https://status.example.test/deploy" };

describePostgres("the chat a routine posts in (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const addresses: string[] = [];
  const people: Array<{ userId: string; spaceId: string }> = [];
  const enqueued: BackgroundJob[] = [];
  let deps: ExecutorDeps & ScheduleToolDeps;

  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    deps = {
      prisma: db.prisma,
      jobs: {
        enqueue: async (job: BackgroundJob) => {
          enqueued.push(job);
        },
        enqueueIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: async () => ({ seq: 1 }),
        notify: async () => undefined,
        publishSpaceChange: async () => undefined,
      },
    } as unknown as ExecutorDeps & ScheduleToolDeps;
  });

  afterAll(async () => {
    if (db) {
      await system.messagingIdentity.deleteMany({ where: { address: { in: addresses } } });
      for (const { userId, spaceId } of people) {
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  /** A person with a bot and its main chat; `extra` adds an extra chat of the bot. */
  async function owner(extra = true) {
    const address = `dozo-routine-chat-${randomUUID()}@example.test`;
    addresses.push(address);
    const made = await runAsSystem("routine chat fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    people.push(made);
    const chat = extra ? await extraChat(made, "Garden") : null;
    return { ...made, mainId: made.threadId, chatId: chat };
  }

  async function extraChat(made: { spaceId: string; userId: string; botId: string }, name: string) {
    return system.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: { spaceId: made.spaceId, userId: made.userId },
        select: { id: true },
      });
      await tx.$executeRaw`
        INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name)
        VALUES (${thread.id}, ${made.botId}, ${made.spaceId}, ${name})`;
      return thread.id;
    });
  }

  const archive = (chatId: string, archived: boolean) =>
    system.$executeRaw`
      UPDATE dozo_bot_chats
      SET "archivedAt" = CASE WHEN ${archived}::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE "threadId" = ${chatId}`;

  /** A recurring routine of the bot, posting in `threadId`, due `ago` before now. */
  async function routine(
    who: Awaited<ReturnType<typeof owner>>,
    threadId: string | null,
    ago = MINUTE,
    daily = false,
  ) {
    const dueAt = new Date(Math.floor((Date.now() - ago) / MINUTE) * MINUTE);
    // Daily at the minute it was due, so no later occurrence falls inside the catch-up window.
    const cron = daily ? `${dueAt.getUTCMinutes()} ${dueAt.getUTCHours()} * * *` : "* * * * *";
    const row = await system.routine.create({
      data: {
        spaceId: who.spaceId,
        botId: who.botId,
        userId: who.userId,
        threadId,
        name: "Digest",
        prompt: "Summarize",
        crons: [cron],
        timezone: "UTC",
        active: true,
        nextRunAt: dueAt,
      },
    });
    return { id: row.id, dueAt };
  }

  const wake = (id: string, at: Date) =>
    runAsSystem("routine wake", () => wakeRoutine(deps, id, at.toISOString()));
  const runsOf = (routineId: string) =>
    system.run.findMany({
      where: { routineId },
      select: { id: true, threadId: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  const notesIn = (threadId: string) =>
    system.message.findMany({
      where: { threadId, role: "system", clientNonce: { startsWith: "dozo-routine-chat:" } },
      select: { blocks: true, clientNonce: true },
    });

  it("runs in the main chat, as before, for a bot without extra chats", async () => {
    const who = await owner(false);
    for (const threadId of [null, who.mainId]) {
      const { id, dueAt } = await routine(who, threadId);
      await wake(id, dueAt);
      expect(await runsOf(id)).toEqual([expect.objectContaining({ threadId: who.mainId })]);
    }
    expect(await notesIn(who.mainId)).toEqual([]);
  });

  it("runs in the bot's open extra chat it points at, and leaves the main chat alone", async () => {
    const who = await owner();
    const { id, dueAt } = await routine(who, who.chatId);
    await wake(id, dueAt);
    expect(await runsOf(id)).toEqual([expect.objectContaining({ threadId: who.chatId })]);
    expect(await system.task.count({ where: { threadId: who.mainId } })).toBe(0);
    expect(await notesIn(who.mainId)).toEqual([]);
  });

  it("runs a routine made in an extra chat there, as the tool says, and a wait made there too", async () => {
    const who = await owner();
    const made = await runAsTenant(who, () =>
      createScheduleFromTool(deps, {
        spaceId: who.spaceId,
        botId: who.botId,
        userId: who.userId,
        threadId: who.chatId!,
        name: "Water",
        prompt: "Remind me to water",
        timezone: "UTC",
        schedule: { watch: WATCH },
      }),
    );
    if (!("ok" in made) || !made.routineId) throw new Error(JSON.stringify(made));
    expect(
      (await system.routine.findUniqueOrThrow({ where: { id: made.routineId } })).threadId,
    ).toBe(who.chatId);
    const waited = await runAsTenant(who, () =>
      dozoCreateSchedule(createScheduleFromTool, 30, deps, {
        spaceId: who.spaceId,
        botId: who.botId,
        userId: who.userId,
        threadId: who.chatId!,
        name: "deploy",
        prompt: "Report the deploy",
        timezone: "UTC",
        schedule: { watch: WATCH },
      }),
    );
    if (!("ok" in waited) || !waited.routineId) throw new Error(JSON.stringify(waited));
    const deadline = new Date(Date.now() - MINUTE);
    await system.$executeRaw`UPDATE dozo_routine_waits SET "endsAt" = ${deadline.toISOString()}::timestamptz WHERE "routineId" = ${waited.routineId}`;
    await system.routine.update({ where: { id: waited.routineId }, data: { nextRunAt: deadline } });
    await wake(waited.routineId, deadline);
    expect(await runsOf(waited.routineId)).toEqual([
      expect.objectContaining({ threadId: who.chatId }),
    ]);
  });

  it("runs in the main chat while its chat is archived, saying so once per run, and goes back after", async () => {
    const who = await owner();
    const { id, dueAt } = await routine(who, who.chatId, 5 * MINUTE);
    await archive(who.chatId!, true);
    await wake(id, dueAt);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ threadId: who.mainId });
    const note = [{ kind: "meta", text: dozoRoutineChatNote("Digest", "Garden") }];
    expect(await notesIn(who.mainId)).toEqual([
      { blocks: note, clientNonce: `dozo-routine-chat:${run!.id}` },
    ]);
    expect(await system.message.count({ where: { threadId: who.chatId! } })).toBe(0);
    // The routine keeps its chat: brought back, the next occurrence posts there, with no note.
    expect((await system.routine.findUniqueOrThrow({ where: { id } })).threadId).toBe(who.chatId);
    await archive(who.chatId!, false);
    // The next occurrence, already due.
    const next = new Date(dueAt.getTime() + MINUTE);
    await system.routine.update({ where: { id }, data: { nextRunAt: next } });
    await system.run.updateMany({ where: { routineId: id }, data: { status: "completed" } });
    await wake(id, next);
    expect((await runsOf(id)).map((each) => each.threadId)).toEqual([who.mainId, who.chatId]);
    expect(await notesIn(who.mainId)).toHaveLength(1);
  });

  it("never runs in another bot's chat that a routine names, nor writes a note for it", async () => {
    const who = await owner();
    const other = await system.bot.create({
      data: { spaceId: who.spaceId, userId: who.userId, name: "Scout", color: "test" },
    });
    await system.thread.create({
      data: { spaceId: who.spaceId, userId: who.userId, botId: other.id },
    });
    const theirs = await extraChat({ ...who, botId: other.id }, "Trails");
    const { id, dueAt } = await routine(who, theirs);
    await wake(id, dueAt);
    expect(await runsOf(id)).toEqual([expect.objectContaining({ threadId: who.mainId })]);
    expect(await system.task.count({ where: { threadId: theirs } })).toBe(0);
    expect(await notesIn(who.mainId)).toEqual([]);
  });

  it("holds a routine through quiet hours and runs it in its chat when they end", async () => {
    const who = await owner();
    const { id, dueAt } = await routine(who, who.chatId);
    const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const save = (ranges: Parameters<typeof saveDozoQuietHours>[2]) =>
      saveDozoQuietHours(deps as never, who.userId, ranges);
    await save([
      {
        startMinute: (minute + 1380) % 1440,
        endMinute: (minute + 60) % 1440,
        days: DOZO_QUIET_DAYS.ALL,
      },
    ]);
    await wake(id, dueAt);
    expect(await runsOf(id)).toEqual([]);
    expect((await system.routine.findUniqueOrThrow({ where: { id } })).nextRunAt!.getTime()).toBe(
      Math.floor(Date.now() / MINUTE) * MINUTE + 60 * MINUTE,
    );
    // Clearing the hours lets it go back to when it was due; that wake runs it in its chat.
    await save([]);
    await wake(id, dueAt);
    expect(await runsOf(id)).toEqual([expect.objectContaining({ threadId: who.chatId })]);
  });

  it("catches up a run missed by hours in its chat, and skips one missed past the window", async () => {
    const who = await owner();
    const late = await routine(who, who.chatId, 2 * HOUR);
    await wake(late.id, late.dueAt);
    expect(await runsOf(late.id)).toEqual([expect.objectContaining({ threadId: who.chatId })]);
    const missed = await routine(who, who.chatId, DOZO_ROUTINE_CATCH_UP_MS + HOUR, true);
    await wake(missed.id, missed.dueAt);
    expect(await runsOf(missed.id)).toEqual([]);
    expect(await system.task.count({ where: { threadId: who.mainId } })).toBe(0);
  });

  it("folds a tick into the one still queued in its chat, as it does in the main chat", async () => {
    const who = await owner();
    const { id, dueAt } = await routine(who, who.chatId, 5 * MINUTE);
    await wake(id, dueAt);
    // The next occurrence comes due while the first run still waits in the chat's queue.
    const next = new Date(dueAt.getTime() + MINUTE);
    await system.routine.update({ where: { id }, data: { nextRunAt: next } });
    await wake(id, next);
    expect((await system.routine.findUniqueOrThrow({ where: { id } })).lastRunAt).not.toBeNull();
    expect(await runsOf(id)).toEqual([
      expect.objectContaining({ threadId: who.chatId, status: "queued" }),
    ]);
  });

  it("retries a failed run in its open chat, and not in an archived one", async () => {
    const who = await owner();
    const { id, dueAt } = await routine(who, who.chatId);
    await wake(id, dueAt);
    const [failed] = await runsOf(id);
    await system.run.update({ where: { id: failed!.id }, data: { status: "failed" } });
    // The next occurrence is far enough away for a retry to be worth it.
    await system.routine.update({
      where: { id },
      data: { nextRunAt: new Date(Date.now() + 6 * HOUR) },
    });
    await runAsSystem("routine retry", () => retryRoutineRun(deps, failed!.id));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ threadId: who.chatId });

    const later = await owner();
    const second = await routine(later, later.chatId);
    await wake(second.id, second.dueAt);
    const [lost] = await runsOf(second.id);
    await system.run.update({ where: { id: lost!.id }, data: { status: "failed" } });
    await system.routine.update({
      where: { id: second.id },
      data: { nextRunAt: new Date(Date.now() + 6 * HOUR) },
    });
    await archive(later.chatId!, true);
    deps.notifications = { send: vi.fn(async () => undefined) } as never;
    await runAsSystem("routine retry", () => retryRoutineRun(deps, lost!.id)).catch(
      () => undefined,
    );
    expect(await runsOf(second.id)).toHaveLength(1);
    expect(await system.task.count({ where: { threadId: later.mainId } })).toBe(0);
  });

  it("counts a bot's sends from every chat against the one daily limit", async () => {
    const who = await owner();
    await system.$executeRaw`
      INSERT INTO dozo_send_limits ("userId", "dailySends") VALUES (${who.userId}, 1)`;
    const context = (threadId: string) =>
      ({
        deps: { prisma: system },
        run: { userId: who.userId, threadId },
        thread: { id: threadId },
        bot: { id: who.botId },
      }) as unknown as RunContext;
    const call = {
      name: "send_email",
      args: {},
      viaConnector: false,
      connectorChanges: 0,
      approved: false,
    };
    expect(await dozoSendLimitGate(context(who.chatId!), { ...call, args: {} }, "allow")).toBe(
      "allow",
    );
    expect(await dozoSendLimitGate(context(who.mainId), { ...call, args: {} }, "allow")).toBe(
      "ask",
    );
  });
});
