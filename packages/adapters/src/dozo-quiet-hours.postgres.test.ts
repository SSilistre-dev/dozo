import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dozoHoldRoutine,
  readDozoQuietHours,
  saveDozoQuietHours,
  suggestDozoQuietHours,
} from "./dozo-quiet-hours.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh, which also runs it with the
// database in other time zones than UTC). The fork's unit gate has no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const { ALL } = DOZO_QUIET_DAYS;

describePostgres("quiet hours on routines (PostgreSQL)", () => {
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

  async function person(timezone: string | null = "UTC"): Promise<Actor> {
    const id = `quiet-hours-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true, timezone },
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

  /** A routine due a minute ago, in a quiet range around now (UTC minutes, as the user's zone). */
  async function heldRoutine() {
    const actor = await person();
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const now = Date.now();
    const dueAt = new Date(Math.floor(now / MINUTE) * MINUTE - MINUTE);
    const routine = await system.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        userId: actor.userId,
        name: "Digest",
        prompt: "Summarize",
        crons: ["* * * * *"],
        timezone: "UTC",
        active: true,
        nextRunAt: dueAt,
      },
    });
    const minute = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
    // Two touching ranges: the hold lasts until the second one ends.
    const quiet = [
      { startMinute: (minute + 1380) % 1440, endMinute: (minute + 60) % 1440, days: ALL },
      { startMinute: (minute + 60) % 1440, endMinute: (minute + 120) % 1440, days: ALL },
    ];
    const enqueued: BackgroundJob[] = [];
    const deps = {
      prisma: system,
      jobs: {
        enqueue: vi.fn(async (job: BackgroundJob) => {
          enqueued.push(job);
        }),
      } as unknown as JobPublisher,
      events: { publishSpaceChange: vi.fn(async () => undefined) },
    };
    await saveDozoQuietHours({ ...deps, prisma }, actor.userId, quiet);
    const wake = vi.fn(async () => undefined);
    const waiting = { ...routine, watch: null };
    expect(await dozoHoldRoutine(deps, waiting, dueAt, wake)).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    const held = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    const heldUntil = held.nextRunAt!;
    // Two hours from now, on a whole minute: the end of the second range.
    expect(heldUntil.getTime()).toBe(Math.floor(now / MINUTE) * MINUTE + 120 * MINUTE);
    enqueued.length = 0;
    return { actor, deps, routine: waiting, dueAt, heldUntil, enqueued, wake };
  }

  it("lets a held routine go back to when it was due once its hours change", async () => {
    const { actor, deps, routine, dueAt, enqueued } = await heldRoutine();
    await saveDozoQuietHours({ ...deps, prisma }, actor.userId, []);
    const released = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(released.nextRunAt?.toISOString()).toBe(dueAt.toISOString());
    expect(enqueued).toEqual([routineWakeupJob(routine.id, dueAt)]);
  });

  it("wakes the occurrence it held, with its due time, when the hold ends", async () => {
    const { deps, routine, dueAt, heldUntil, wake } = await heldRoutine();
    expect(await dozoHoldRoutine(deps, routine, heldUntil, wake)).toBe(true);
    expect(wake).toHaveBeenCalledWith(deps, routine.id, dueAt.toISOString());
    const restored = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(restored.nextRunAt?.toISOString()).toBe(dueAt.toISOString());
  });
  it("saves ranges in order, keeps the previous release's table in step, and clears both", async () => {
    const actor = await person();
    const deps = { prisma, jobs: { enqueue: vi.fn() } as unknown as JobPublisher };
    const lunch = { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS };
    const night = { startMinute: 22 * 60, endMinute: 7 * 60, days: ALL };
    const legacy = () =>
      system.$queryRaw<Array<{ startMinute: number; endMinute: number }>>`
        SELECT "startMinute", "endMinute" FROM dozo_quiet_hours WHERE "userId" = ${actor.userId}`;
    await saveDozoQuietHours(deps, actor.userId, [night]);
    await saveDozoQuietHours(deps, actor.userId, [lunch, night]);
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([lunch, night]);
    expect(await legacy()).toEqual([{ startMinute: 12 * 60, endMinute: 13 * 60 }]);
    // Two saves at once both land whole: one wins, neither fails on the other's rows.
    await Promise.all([
      saveDozoQuietHours(deps, actor.userId, [night, lunch]),
      saveDozoQuietHours(deps, actor.userId, [lunch, night]),
    ]);
    expect(await readDozoQuietHours(prisma, actor.userId)).toHaveLength(2);
    await saveDozoQuietHours(deps, actor.userId, []);
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([]);
    expect(await legacy()).toEqual([]);
  });

  it("reads a range the previous release saved as one on every day", async () => {
    const actor = await person();
    await system.$executeRaw`
      INSERT INTO dozo_quiet_hours ("userId", "startMinute", "endMinute")
      VALUES (${actor.userId}, ${22 * 60}, ${7 * 60})`;
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([
      { startMinute: 22 * 60, endMinute: 7 * 60, days: ALL },
    ]);
  });

  it("follows the previous release's change or clearing made after a save", async () => {
    const actor = await person();
    const deps = { prisma, jobs: { enqueue: vi.fn() } as unknown as JobPublisher };
    const lunch = { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS };
    const night = { startMinute: 22 * 60, endMinute: 7 * 60, days: ALL };
    // The previous release's own statements, as it saves and clears its one range.
    const previousSave = (startMinute: number, endMinute: number) =>
      system.$executeRaw`
        INSERT INTO dozo_quiet_hours ("userId", "startMinute", "endMinute")
        VALUES (${actor.userId}, ${startMinute}, ${endMinute})
        ON CONFLICT ("userId") DO UPDATE SET "startMinute" = EXCLUDED."startMinute",
          "endMinute" = EXCLUDED."endMinute", "updatedAt" = CURRENT_TIMESTAMP`;
    const previousClear = () =>
      system.$executeRaw`DELETE FROM dozo_quiet_hours WHERE "userId" = ${actor.userId}`;

    await saveDozoQuietHours(deps, actor.userId, [lunch, night]);
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([lunch, night]);
    await previousSave(8 * 60, 9 * 60);
    const changed = [{ startMinute: 8 * 60, endMinute: 9 * 60, days: lunch.days }, night];
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual(changed);
    // New times start from what is read, and put both tables back in step.
    const later = { startMinute: 9 * 60, endMinute: 10 * 60 };
    expect(await saveDozoQuietHours(deps, actor.userId, { hours: later })).toEqual([
      { ...later, days: lunch.days },
      night,
    ]);
    await previousClear();
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([]);
    // Turned on again by the previous release: its range on the first one's days, the rest back.
    await previousSave(later.startMinute, later.endMinute);
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([
      { ...later, days: lunch.days },
      night,
    ]);
  });

  it("holds no routine on ranges the previous release cleared", async () => {
    const { actor, deps, routine, dueAt } = await heldRoutine();
    await system.$executeRaw`DELETE FROM dozo_quiet_hours WHERE "userId" = ${actor.userId}`;
    // The hold's own wake ends it; a fresh due time inside the old ranges now runs.
    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
    await system.$executeRaw`DELETE FROM dozo_routine_holds WHERE "routineId" = ${routine.id}`;
    expect(await dozoHoldRoutine(deps, routine, dueAt, vi.fn())).toBe(false);
  });

  it("refuses ranges that leave no minute outside them, and keeps the saved ones", async () => {
    const actor = await person();
    const deps = { prisma, jobs: { enqueue: vi.fn() } as unknown as JobPublisher };
    const first = { startMinute: 60, endMinute: 120, days: ALL };
    const rest = { startMinute: 12 * 60, endMinute: 0, days: ALL };
    await saveDozoQuietHours(deps, actor.userId, [first, rest]);
    await expect(
      saveDozoQuietHours(deps, actor.userId, { hours: { startMinute: 0, endMinute: 12 * 60 } }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    expect(await readDozoQuietHours(prisma, actor.userId)).toEqual([first, rest]);
  });

  it("refuses a range on no day, or a fifth range", async () => {
    const actor = await person();
    await expect(
      system.$executeRaw`
        INSERT INTO dozo_quiet_hour_ranges ("userId", position, "startMinute", "endMinute", days)
        VALUES (${actor.userId}, 0, 60, 120, 0)`,
    ).rejects.toThrow();
    await expect(
      system.$executeRaw`
        INSERT INTO dozo_quiet_hour_ranges ("userId", position, "startMinute", "endMinute", days)
        VALUES (${actor.userId}, 4, 60, 120, 1)`,
    ).rejects.toThrow();
  });

  /** Messages at these local hours of each day `from` to `days` days ago, in `zone`. */
  async function writes(
    actor: Actor,
    zone: { offsetHours: number },
    hours: readonly number[],
    options: { from?: number; days?: number; role?: string; author?: string | null } = {},
  ) {
    // A chat of its own: a bot's.
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Pen",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const thread =
      (await system.thread.findFirst({ where: { botId: bot.id } })) ??
      (await system.thread.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id },
      }));
    // Local midnight today, as an instant; the zones used here keep one offset all year.
    const offset = zone.offsetHours * HOUR;
    const midnight = Math.floor((Date.now() + offset) / DAY) * DAY - offset;
    const data = [];
    for (let day = options.from ?? 1; day <= (options.days ?? 14); day += 1)
      for (const hour of hours)
        data.push({
          threadId: thread.id,
          seq: 1000 + data.length,
          role: options.role ?? "user",
          authorUserId: options.author === undefined ? actor.userId : options.author,
          blocks: [{ kind: "text", text: "hello" }],
          createdAt: new Date(midnight - day * DAY + hour * HOUR + 5 * MINUTE),
        });
    await system.message.createMany({ data });
  }

  const daytime = Array.from({ length: 15 }, (_, index) => 8 + index);
  const nightOnly = [23, 0, 1, 2, 3, 4, 5, 6, 7];

  it("suggests the night from the caller's own messages, in the caller's zone", async () => {
    // Tokyo is UTC+9 all year: written from 08:00 to 23:00 there, quiet from 23:00 to 08:00.
    const ada = await person("Asia/Tokyo");
    await writes(ada, { offsetHours: 9 }, daytime);
    const before = await suggestDozoQuietHours(prisma, ada.userId);
    expect(before).toEqual([{ startMinute: 23 * 60, endMinute: 8 * 60, days: ALL }]);

    // Someone else's messages at night, in the same chat, and bot replies at night change nothing.
    const eve = await person("Asia/Tokyo");
    await writes(ada, { offsetHours: 9 }, nightOnly, { author: eve.userId });
    await writes(ada, { offsetHours: 9 }, nightOnly, { role: "bot" });
    // Nor do messages no person wrote: a webhook's delivery, an imported history.
    await writes(ada, { offsetHours: 9 }, nightOnly, { author: null });
    // Nor does anything older than four weeks.
    await writes(ada, { offsetHours: 9 }, nightOnly, { from: 30, days: 40 });
    expect(await suggestDozoQuietHours(prisma, ada.userId)).toEqual(before);
  });

  it("reads a zone it does not know as UTC", async () => {
    const ada = await person("Not/AZone");
    await writes(ada, { offsetHours: 0 }, daytime);
    expect(await suggestDozoQuietHours(prisma, ada.userId)).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: ALL },
    ]);
    const bea = await person(null);
    await writes(bea, { offsetHours: 0 }, daytime);
    expect(await suggestDozoQuietHours(prisma, bea.userId)).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: ALL },
    ]);
  });

  it("suggests nothing from too few messages", async () => {
    const ada = await person();
    await writes(ada, { offsetHours: 0 }, [12], { days: 10 });
    expect(await suggestDozoQuietHours(prisma, ada.userId)).toBeNull();
  });
});
