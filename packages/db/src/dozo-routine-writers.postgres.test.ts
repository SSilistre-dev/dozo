import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./database/client.js";
import { createDb } from "./database/client.js";
import { readRoutineWriter, recordRoutineWriter } from "./dozo-routine-writers.js";
import { asSystem, runAsTenant } from "./database/row-security.js";

// Runs against a migrated database only: DATABASE_URL is the runtime login, which row security
// applies to. The fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("who last wrote a routine (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  const ids: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({ where: { id: { in: ids } } });
    await system.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function space() {
    const id = randomUUID();
    ids.push(id);
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "P", slug: id, createdAt: new Date() } });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Chef", color: "test" },
    });
    const routine = await system.routine.create({
      data: { spaceId: id, botId: bot.id, userId: id, name: "Daily", prompt: "Check", crons: [] },
    });
    const as = <T>(work: () => Promise<T>) => runAsTenant({ spaceId: id, userId: id }, work);
    return { id, routineId: routine.id, as };
  }

  it("records the last writer and when, in every database time zone", async () => {
    const home = await space();
    const routine = { routineId: home.routineId, spaceId: home.id };
    expect(await home.as(() => readRoutineWriter(prisma, home.routineId))).toBeUndefined();
    const before = Date.now();
    await home.as(() => recordRoutineWriter(prisma, routine, "owner"));
    const first = await home.as(() => readRoutineWriter(prisma, home.routineId));
    expect(first?.writer).toBe("owner");
    // Read back as the instant it was written, whatever the session's zone.
    expect(Math.abs(first!.writtenAt.getTime() - before)).toBeLessThan(60_000);
    await home.as(() => recordRoutineWriter(prisma, routine, "outside_run"));
    const second = await home.as(() => readRoutineWriter(prisma, home.routineId));
    expect(second?.writer).toBe("outside_run");
    expect(second!.writtenAt.getTime()).toBeGreaterThanOrEqual(first!.writtenAt.getTime());
  });

  it("refuses a writer it does not know", async () => {
    const home = await space();
    await expect(
      home.as(() =>
        recordRoutineWriter(prisma, { routineId: home.routineId, spaceId: home.id }, "someone"),
      ),
    ).rejects.toThrow();
  });

  it("records nothing for another Space's routine, shows it to its own Space only, and goes with it", async () => {
    const home = await space();
    const away = await space();
    await away.as(() =>
      recordRoutineWriter(prisma, { routineId: home.routineId, spaceId: away.id }, "owner"),
    );
    expect(await home.as(() => readRoutineWriter(prisma, home.routineId))).toBeUndefined();
    await home.as(() =>
      recordRoutineWriter(prisma, { routineId: home.routineId, spaceId: home.id }, "member"),
    );
    expect(await away.as(() => readRoutineWriter(prisma, home.routineId))).toBeUndefined();
    await system.routine.delete({ where: { id: home.routineId } });
    const rows = await system.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "dozo_routine_writers" WHERE "routineId" = ${home.routineId}`;
    expect(rows).toEqual([{ n: 0 }]);
  });
});
