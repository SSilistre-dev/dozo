import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant, storedMessageBlocks } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dozoSendDailyDigest,
  readDozoDailyDigest,
  saveDozoDailyDigest,
} from "./dozo-daily-digest.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh, which also runs it with the
// database in other time zones than UTC). The fork's unit gate has no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("daily digest (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (users.length) {
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
    }
    await db?.pool.end();
  });

  async function person(): Promise<Actor> {
    const id = `daily-digest-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: {
        id,
        name: "Ada",
        email: `${id}@example.test`,
        emailVerified: true,
        timezone: "Europe/Istanbul",
        locale: "en",
      },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Home", createdByUserId: id },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { userId: id, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  it("turns on as a routine, writes one message from saved data, and turns off", async () => {
    const actor = await person();
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    const enqueued: BackgroundJob[] = [];
    const deps = {
      prisma: system,
      jobs: {
        enqueue: vi.fn(async (job: BackgroundJob) => {
          enqueued.push(job);
        }),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher,
      events: {
        notify: vi.fn(async () => undefined),
        publishSpaceChange: vi.fn(async () => undefined),
      },
    };

    await saveDozoDailyDigest({ ...deps, prisma }, actor.userId, {
      botId: bot.id,
      minute: 8 * 60,
      spaceId: actor.spaceId,
    });
    expect(await readDozoDailyDigest(system, actor.userId)).toEqual({
      botId: bot.id,
      botName: "Chef",
      minute: 8 * 60,
    });
    const routine = await system.routine.findFirstOrThrow({ where: { botId: bot.id } });
    expect(routine).toMatchObject({ crons: ["0 8 * * *"], timezone: "Europe/Istanbul" });
    // 08:00 in Istanbul is 05:00 UTC, whatever zone the database runs in.
    expect(routine.nextRunAt?.toISOString()).toMatch(/T05:00:00\.000Z$/);
    expect(enqueued).toHaveLength(1);

    // One run waiting for an answer.
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: actor.userId,
        prompt: "Ask",
        status: "queued",
      },
    });
    await system.run.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: actor.userId,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const due = routine.nextRunAt!;
    expect(await dozoSendDailyDigest(deps, routine, bot, thread, due)).toBe(true);
    // A second wake for the same occurrence writes nothing more.
    expect(await dozoSendDailyDigest(deps, routine, bot, thread, due)).toBe(true);
    const messages = await system.message.findMany({ where: { threadId: thread.id, role: "bot" } });
    expect(messages).toHaveLength(1);
    expect(storedMessageBlocks(messages[0]!)).toEqual([
      { kind: "text", text: "**Waiting for you**\n- Chef: 1" },
    ]);
    const after = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(after.nextRunAt?.getTime()).toBe(due.getTime() + 24 * 60 * 60_000);

    await saveDozoDailyDigest({ ...deps, prisma }, actor.userId, null);
    expect(await readDozoDailyDigest(system, actor.userId)).toBeNull();
    expect(await system.routine.count({ where: { id: routine.id } })).toBe(0);
  });
});
