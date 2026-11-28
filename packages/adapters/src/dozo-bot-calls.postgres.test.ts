import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBotCallPermission, writeBotCallPermission } from "./dozo-bot-calls.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh, which also runs it with the
// database in other time zones than UTC). The fork's unit gate has no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("a bot's permission to call (PostgreSQL)", () => {
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
    const id = `bot-calls-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
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

  async function botOf(actor: Actor) {
    return runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
  }

  it("is off until allowed, can be turned off again, and goes with the bot", async () => {
    const ada = await person();
    const bot = await botOf(ada);
    const mine = { userId: ada.userId, botId: bot.id, spaceId: ada.spaceId };
    const read = () =>
      runAsTenant(ada, () => readBotCallPermission(prisma, ada.userId, bot.id));
    expect(await read()).toBe(false);
    await runAsTenant(ada, () => writeBotCallPermission(prisma, { ...mine, allowed: true }));
    await runAsTenant(ada, () => writeBotCallPermission(prisma, { ...mine, allowed: true }));
    expect(await read()).toBe(true);
    await runAsTenant(ada, () => writeBotCallPermission(prisma, { ...mine, allowed: false }));
    expect(await read()).toBe(false);
    await runAsTenant(ada, () => writeBotCallPermission(prisma, { ...mine, allowed: true }));
    await system.bot.delete({ where: { id: bot.id } });
    expect(await readBotCallPermission(system, ada.userId, bot.id)).toBe(false);
  });

  it("is not given for another person's bot, and is not seen by anyone else", async () => {
    const ada = await person();
    const bea = await person();
    const bot = await botOf(ada);
    await runAsTenant(bea, () =>
      writeBotCallPermission(prisma, {
        userId: bea.userId,
        botId: bot.id,
        spaceId: bea.spaceId,
        allowed: true,
      }),
    );
    expect(await readBotCallPermission(system, bea.userId, bot.id)).toBe(false);
    await runAsTenant(ada, () =>
      writeBotCallPermission(prisma, {
        userId: ada.userId,
        botId: bot.id,
        spaceId: ada.spaceId,
        allowed: true,
      }),
    );
    expect(await runAsTenant(bea, () => readBotCallPermission(prisma, ada.userId, bot.id))).toBe(
      false,
    );
  });
});
