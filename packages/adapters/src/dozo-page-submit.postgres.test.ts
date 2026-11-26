import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dozoNotePageSubmits } from "./dozo-page-submit.js";
import { dozoSendLimitGate } from "./dozo-send-limit.js";
import type { RunContext } from "./runs/assembly/run-context.js";

// Runs on the branded tree only, against a migrated database (dozo/docker/postgres-tests.sh, in UTC and two
// other database time zones). The fork's unit gate has no database and skips it.
const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe : describe.skip;

describePostgres("daily limit on page submits (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const users: string[] = [];

  async function account(dailySends: number, timezone: string | null = null) {
    const id = `page-submits-${randomUUID()}`;
    users.push(id);
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true, timezone },
    });
    await system.organization.create({
      data: { id, name: "Personal", slug: id, createdAt: new Date() },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Home", createdByUserId: id },
    });
    await system.$executeRaw`
      INSERT INTO dozo_send_limits ("userId", "dailySends") VALUES (${id}, ${dailySends})`;
    const bot = () =>
      system.bot.create({ data: { spaceId, userId: id, name: "Chef", color: "slate" } });
    return { userId: id, botId: (await bot()).id, otherBotId: (await bot()).id };
  }

  const run = (userId: string, botId: string) =>
    ({ deps: { prisma: system }, run: { userId }, bot: { id: botId } }) as unknown as RunContext;

  /** A browser_act call whose clicks the computer's page browser said submit `count` forms. */
  const press = (count = 1) => {
    const actions = Array.from({ length: count }, (_, at) => ({ kind: "click", ref: `e${at}` }));
    dozoNotePageSubmits("browser_act", { actions }, count);
    return {
      name: "browser_act",
      args: { actions },
      viaConnector: false,
      connectorChanges: 0,
      approved: false,
    };
  };

  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });

  afterAll(async () => {
    if (db) {
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
      await db.prisma.$disconnect();
    }
  });

  it("never lets more submits through than the number, however many race", async () => {
    const { userId, botId } = await account(5);
    const answers = await Promise.all(
      Array.from({ length: 30 }, () => dozoSendLimitGate(run(userId, botId), press(), "allow")),
    );
    expect(answers.filter((answer) => answer === "allow")).toHaveLength(5);
    expect(answers.filter((answer) => answer === "ask")).toHaveLength(25);
    const [row] = await system.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM dozo_daily_sends WHERE "botId" = ${botId}`;
    expect(row?.count).toBe(5);
  });

  it("takes a batch's submits together at the exact edge, and none when they do not fit", async () => {
    const { userId, botId } = await account(4);
    const gate = (count: number) => dozoSendLimitGate(run(userId, botId), press(count), "allow");
    expect(await gate(3)).toBe("allow");
    expect(await gate(2)).toBe("ask");
    expect(await gate(1)).toBe("allow");
    expect(await gate(1)).toBe("ask");
  });

  it("counts each bot and each account apart", async () => {
    const first = await account(2);
    const second = await account(2);
    expect(await dozoSendLimitGate(run(first.userId, first.botId), press(2), "allow")).toBe(
      "allow",
    );
    expect(await dozoSendLimitGate(run(first.userId, first.botId), press(), "allow")).toBe("ask");
    expect(await dozoSendLimitGate(run(first.userId, first.otherBotId), press(2), "allow")).toBe(
      "allow",
    );
    expect(await dozoSendLimitGate(run(second.userId, second.botId), press(2), "allow")).toBe(
      "allow",
    );
  });

  it("counts nothing for a call a person decided, or one that submits nothing", async () => {
    const { userId, botId } = await account(1);
    expect(
      await dozoSendLimitGate(run(userId, botId), { ...press(), approved: true }, "allow"),
    ).toBe("allow");
    expect(await dozoSendLimitGate(run(userId, botId), press(), "ask")).toBe("ask");
    const plain = { ...press(), args: { actions: [{ kind: "click", ref: "e1" }] } };
    expect(await dozoSendLimitGate(run(userId, botId), plain, "allow")).toBe("allow");
    const left = await system.$queryRaw<unknown[]>`
      SELECT 1 FROM dozo_daily_sends WHERE "botId" = ${botId}`;
    expect(left).toHaveLength(0);
  });
});
