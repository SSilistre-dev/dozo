import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOZO_ROUTINE_CATCH_UP_MS } from "./dozo-quiet-hours.js";
import {
  DOZO_MAX_WAITS_PER_BOT,
  dozoCreateSchedule,
  dozoTickWait,
  dozoWaitRefusal,
} from "./dozo-wait.js";
import type { tickRoutineWatch } from "./routines/routine-watch.js";
import { wakeRoutine } from "./runs/assembly/run-routines.js";
import type { ExecutorDeps } from "./runs/executor/executor-deps.js";
import type { ScheduleToolDeps } from "./tools/schedule-tools.js";
import { createScheduleFromTool } from "./tools/schedule-tools.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe : describe.skip;

const WATCH = { kind: "http", url: "https://status.example.test/deploy" };
const MINUTE = 60_000;

/** `client` with some of its methods replaced, leaving the client itself as it was. */
function only<T extends object>(client: T, replaced: Record<string, unknown>): T {
  return new Proxy(client, {
    get(target, key) {
      if (typeof key === "string" && key in replaced) return replaced[key];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describePostgres("one-time waits (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let owner: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `dozo-wait-${randomUUID()}@example.test`;
  const enqueued: BackgroundJob[] = [];
  let deps: ScheduleToolDeps;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("one-time wait fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    owner = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
      threadId: provisioned.threadId,
    };
    deps = {
      prisma: db.prisma,
      jobs: {
        enqueue: async (job: BackgroundJob) => {
          enqueued.push(job);
        },
        enqueueIn: async () => undefined,
        enqueueManyIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: async () => ({ seq: 1 }),
        notify: async () => undefined,
        publishSpaceChange: async () => undefined,
      },
    } as unknown as ScheduleToolDeps;
  });

  afterAll(async () => {
    if (owner) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: owner.spaceId } });
      await system.user.deleteMany({ where: { id: owner.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  /** schedule_create with a watch and waitMinutes, as the tool handler calls it. */
  function wait(name: string, minutes = 60, using = deps) {
    return runAsTenant(owner, () =>
      dozoCreateSchedule(createScheduleFromTool, minutes, using, {
        spaceId: owner.spaceId,
        botId: owner.botId,
        userId: owner.userId,
        threadId: owner.threadId,
        name,
        prompt: `Report ${name}`,
        timezone: "UTC",
        schedule: { watch: WATCH },
      }),
    );
  }

  function routineId(created: Awaited<ReturnType<typeof wait>>): string {
    if (!("ok" in created) || !created.routineId) throw new Error(JSON.stringify(created));
    return created.routineId;
  }

  async function waitRow(id: string) {
    const rows = await system.$queryRaw<Array<{ endsAt: Date; minutes: number }>>`
      SELECT "endsAt" AT TIME ZONE 'UTC' AS "endsAt", minutes
      FROM dozo_routine_waits WHERE "routineId" = ${id}`;
    return rows[0];
  }

  /** Puts a wait's deadline, and its routine's next wake, at `at`. */
  async function dueAt(id: string, at: Date) {
    await system.$executeRaw`UPDATE dozo_routine_waits SET "endsAt" = ${at.toISOString()}::timestamptz WHERE "routineId" = ${id}`;
    await system.routine.update({ where: { id }, data: { nextRunAt: at } });
  }

  async function endAll() {
    await system.routine.updateMany({
      where: { botId: owner.botId },
      data: { active: false, nextRunAt: null },
    });
  }

  it("records a wait, runs once in its chat at the deadline, and ends", async () => {
    const id = routineId(await wait("deploy", 45));
    const row = await waitRow(id);
    expect(row?.minutes).toBe(45);
    expect(Math.abs((row?.endsAt.getTime() ?? 0) - (Date.now() + 45 * MINUTE))).toBeLessThan(
      MINUTE,
    );

    const deadline = new Date(Date.now() - MINUTE);
    await dueAt(id, deadline);
    await runAsSystem("one-time wait wake", () =>
      wakeRoutine(deps as unknown as ExecutorDeps, id, deadline.toISOString()),
    );
    const runs = await system.run.findMany({ where: { routineId: id }, include: { task: true } });
    expect(runs).toEqual([
      expect.objectContaining({ threadId: owner.threadId, trigger: "routine" }),
    ]);
    expect(runs[0]?.task.prompt).toMatch(/one-time wait on HTTPS endpoint ended after 45 minutes/);
    expect(await system.routine.findUnique({ where: { id } })).toMatchObject({
      active: false,
      nextRunAt: null,
    });
    await endAll();
  });

  it("moves a check that would come after the deadline onto it", async () => {
    const id = routineId(await wait("page"));
    const deadline = new Date(Date.now() + 5 * MINUTE);
    await dueAt(id, new Date(Date.now() - 1_000));
    await system.$executeRaw`UPDATE dozo_routine_waits SET "endsAt" = ${deadline.toISOString()}::timestamptz WHERE "routineId" = ${id}`;
    const routine = await system.routine.findUniqueOrThrow({ where: { id } });
    const later = new Date(Date.now() + 15 * MINUTE);
    const quietCheck = (async () => {
      await system.routine.update({ where: { id }, data: { nextRunAt: later } });
      return { run: false as const };
    }) as unknown as typeof tickRoutineWatch;
    const tick = await runAsSystem("one-time wait check", () =>
      dozoTickWait(
        quietCheck,
        deps as unknown as Parameters<typeof tickRoutineWatch>[0],
        routine,
        { threadId: owner.threadId, botId: owner.botId },
        routine.nextRunAt ?? new Date(),
      ),
    );
    expect(tick).toEqual({ run: false });
    expect((await system.routine.findUnique({ where: { id } }))?.nextRunAt).toEqual(deadline);
    expect(enqueued.at(-1)).toMatchObject({ name: "routine.wakeup", availableAt: deadline });
    await endAll();
  });

  it("ends a wait whose deadline was missed by more than the catch-up window, without a run", async () => {
    const id = routineId(await wait("backup"));
    const deadline = new Date(Date.now() - DOZO_ROUTINE_CATCH_UP_MS - MINUTE);
    await dueAt(id, deadline);
    await runAsSystem("one-time wait wake", () =>
      wakeRoutine(deps as unknown as ExecutorDeps, id, deadline.toISOString()),
    );
    expect(await system.run.count({ where: { routineId: id } })).toBe(0);
    expect((await system.routine.findUnique({ where: { id } }))?.active).toBe(false);
  });

  it("keeps a bot to its limit when two calls race for the last wait", async () => {
    for (let index = 0; index < DOZO_MAX_WAITS_PER_BOT - 1; index += 1)
      routineId(await wait(`build ${index}`));
    // Each call counts before either records its wait. Under the bot's lock the second cannot
    // count until the first commits, so the first records after a short grace instead.
    const countedBy = [deferred(), deferred()];
    let calls = 0;
    const racing = only(db.prisma, {
      $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.prisma.$transaction(async (tx) => {
          const mine = countedBy[calls++ % 2] as ReturnType<typeof deferred>;
          const other = countedBy.find((entry) => entry !== mine) as ReturnType<typeof deferred>;
          return work(
            only(tx, {
              $queryRaw: async (...query: Parameters<typeof tx.$queryRaw>) => {
                const rows = await tx.$queryRaw(...query);
                if (String(query[0]).includes("count(*)")) mine.resolve(undefined);
                return rows;
              },
              $executeRaw: async (...statement: Parameters<typeof tx.$executeRaw>) => {
                await Promise.race([other.promise, abortableDelay(500)]);
                return tx.$executeRaw(...statement);
              },
            }),
          );
        }),
    });
    const using = { ...deps, prisma: racing };
    const raced = await Promise.all([wait("race a", 60, using), wait("race b", 60, using)]);
    expect(raced.filter((created) => "ok" in created)).toHaveLength(1);
    expect(raced.filter((created) => "error" in created)).toEqual([
      { error: expect.stringMatching(/already have 10 waits/) },
    ]);
    const [counted] = await system.$queryRaw<Array<{ going: number }>>`
      SELECT count(*)::int AS going FROM dozo_routine_waits w JOIN routines r ON r.id = w."routineId"
      WHERE r."botId" = ${owner.botId} AND r.active`;
    expect(counted?.going).toBe(DOZO_MAX_WAITS_PER_BOT);
    expect(
      await system.routine.count({
        where: { botId: owner.botId, active: true, name: { startsWith: "race" } },
      }),
    ).toBe(1);
    // Before the approval card, the next one is refused already.
    expect(
      await runAsTenant(owner, () =>
        dozoWaitRefusal(db.prisma, 30, { botId: owner.botId, watch: WATCH }),
      ),
    ).toMatch(/already have 10 waits/);
    await endAll();
  });

  it("drops the wait with its routine", async () => {
    const id = routineId(await wait("delete me"));
    expect(await waitRow(id)).toBeDefined();
    await runAsTenant(owner, () => db.prisma.routine.delete({ where: { id } }));
    expect(await waitRow(id)).toBeUndefined();
  });
});
