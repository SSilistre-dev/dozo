import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./database/client.js";
import { createDb } from "./database/client.js";
import { readDozoDailySends, saveDozoDailySends, takeDozoDailySend } from "./dozo-send-limit.js";
import { asSystem } from "./database/row-security.js";

// Runs on the branded tree only, against a migrated database. The fork's unit gate has no
// database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("daily sends (PostgreSQL)", () => {
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];

  async function owner(timezone: string | null = null) {
    const id = `daily-sends-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true, timezone },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Home", createdByUserId: id },
    });
    const bot = () =>
      system.bot.create({ data: { spaceId, userId: id, name: "Chef", color: "slate" } });
    return { userId: id, botId: (await bot()).id, otherBotId: (await bot()).id };
  }

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    close = () => db.pool.end();
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  it("keeps the default until the account saves a number, then refuses one out of range", async () => {
    const { userId } = await owner();
    expect(await readDozoDailySends(system, userId)).toBe(50);
    await saveDozoDailySends(system, userId, 3);
    await saveDozoDailySends(system, userId, 2);
    expect(await readDozoDailySends(system, userId)).toBe(2);
    await expect(saveDozoDailySends(system, userId, 0)).rejects.toThrow();
  });

  it("counts each bot apart, up to the number, and starts again the next local day", async () => {
    const { userId, botId, otherBotId } = await owner("Pacific/Auckland");
    await saveDozoDailySends(system, userId, 2);
    const morning = new Date("2027-03-01T20:00:00Z");
    const take = (bot: string, at = morning) =>
      takeDozoDailySend(system, { userId, botId: bot, sends: 1 }, at);
    expect(await take(botId)).toEqual({ full: false });
    expect(await take(botId)).toEqual({ full: false });
    expect(await take(botId)).toEqual({ full: true, dailySends: 2 });
    expect(await take(otherBotId)).toEqual({ full: false });
    // Midnight in Auckland, not in UTC.
    expect(await take(botId, new Date("2027-03-02T10:59:00Z"))).toEqual({
      full: true,
      dailySends: 2,
    });
    expect(await take(botId, new Date("2027-03-02T11:00:00Z"))).toEqual({ full: false });
    // Two days on, the old days are gone.
    await take(botId, new Date("2027-03-05T11:00:00Z"));
    const days = await system.$queryRaw<Array<{ day: Date }>>`
      SELECT day FROM dozo_daily_sends WHERE "botId" = ${botId} ORDER BY day`;
    expect(days.map(({ day }) => day.toISOString().slice(0, 10))).toEqual(["2027-03-06"]);
  });

  it("never counts past the number, however many sends race", async () => {
    const { userId, botId } = await owner();
    await saveDozoDailySends(system, userId, 5);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => takeDozoDailySend(system, { userId, botId, sends: 1 })),
    );
    expect(results.filter((result) => !result.full)).toHaveLength(5);
    const [row] = await system.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM dozo_daily_sends WHERE "botId" = ${botId}`;
    expect(row?.count).toBe(5);
  });

  it("takes a batch's sends together, or none of them when they do not fit", async () => {
    const { userId, botId } = await owner();
    await saveDozoDailySends(system, userId, 5);
    const take = (sends: number) => takeDozoDailySend(system, { userId, botId, sends });
    expect(await take(6)).toEqual({ full: true, dailySends: 5 });
    expect(await take(3)).toEqual({ full: false });
    expect(await take(3)).toEqual({ full: true, dailySends: 5 });
    expect(await take(2)).toEqual({ full: false });
    expect(await take(1)).toEqual({ full: true, dailySends: 5 });
  });

  it("goes with its bot and its account", async () => {
    const { userId, botId } = await owner();
    await takeDozoDailySend(system, { userId, botId, sends: 1 });
    await system.bot.delete({ where: { id: botId } });
    const left = await system.$queryRaw<unknown[]>`
      SELECT 1 FROM dozo_daily_sends WHERE "userId" = ${userId}`;
    expect(left).toHaveLength(0);
  });
});
