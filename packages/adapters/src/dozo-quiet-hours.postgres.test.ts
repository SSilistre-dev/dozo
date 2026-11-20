import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dozoHoldRoutine, saveDozoQuietHours } from "./dozo-quiet-hours.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh, which also runs it with the
// database in other time zones than UTC). The fork's unit gate has no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const MINUTE = 60_000;

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

  async function person(): Promise<Actor> {
    const id = `quiet-hours-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true, timezone: "UTC" },
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
    const quiet = { startMinute: (minute + 1380) % 1440, endMinute: (minute + 120) % 1440 };
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
    // Two hours from now, on a whole minute: the end of the quiet range.
    expect(heldUntil.getTime()).toBe(Math.floor(now / MINUTE) * MINUTE + 120 * MINUTE);
    enqueued.length = 0;
    return { actor, deps, routine: waiting, dueAt, heldUntil, enqueued, wake };
  }

  it("lets a held routine go back to when it was due once its hours change", async () => {
    const { actor, deps, routine, dueAt, enqueued } = await heldRoutine();
    await saveDozoQuietHours({ ...deps, prisma }, actor.userId, null);
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
});
