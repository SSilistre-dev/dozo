import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { readBotModelBackups, writeBotModelBackups } from "./dozo-bot-model-backups.js";
import { asSystem, runAsTenant } from "./row-security.js";

// Runs against a migrated database only: DATABASE_URL is the runtime login, which row security
// applies to. The fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("a bot's own backup models (PostgreSQL)", () => {
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
    const as = <T>(work: () => Promise<T>) => runAsTenant({ spaceId: id, userId: id }, work);
    return { id, botId: bot.id, as };
  }

  const first = [
    { provider: "provider-a", modelId: "model-a" },
    { provider: "provider-b", modelId: "model-b", credentialId: "connection-b" },
  ];

  it("saves, replaces and clears a bot's list in its own Space", async () => {
    const home = await space();
    const bot = { botId: home.botId, spaceId: home.id };
    expect(await home.as(() => readBotModelBackups(prisma, home.botId))).toEqual([]);
    expect(await home.as(() => writeBotModelBackups(prisma, bot, first))).toBe(true);
    expect(await home.as(() => readBotModelBackups(prisma, home.botId))).toEqual(first);
    const reordered = [first[1]!, first[0]!];
    expect(await home.as(() => writeBotModelBackups(prisma, bot, reordered))).toBe(true);
    expect(await home.as(() => readBotModelBackups(prisma, home.botId))).toEqual(reordered);
    expect(await home.as(() => writeBotModelBackups(prisma, bot, []))).toBe(true);
    expect(await home.as(() => readBotModelBackups(prisma, home.botId))).toEqual([]);
  });

  it("writes nothing for a bot of another Space and shows a list to its own Space only", async () => {
    const home = await space();
    const away = await space();
    expect(
      await away.as(() =>
        writeBotModelBackups(prisma, { botId: home.botId, spaceId: away.id }, first),
      ),
    ).toBe(false);
    await home.as(() =>
      writeBotModelBackups(prisma, { botId: home.botId, spaceId: home.id }, first),
    );
    expect(await away.as(() => readBotModelBackups(prisma, home.botId))).toEqual([]);
    // The list goes with its bot.
    await system.bot.delete({ where: { id: home.botId } });
    const rows = await system.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "dozo_bot_model_backups" WHERE "botId" = ${home.botId}`;
    expect(rows).toEqual([{ n: 0 }]);
  });
});
