import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { ContentExportRecord } from "./content-export.js";
import { exportContent } from "./content-export.js";
import { asSystem } from "./row-security.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("a bot's extra chats in the content export (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const organizations: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: organizations } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("takes a bot's extra chat whole, as its main chat, not as another bot's chat", async () => {
    const id = randomUUID();
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "P", slug: id, createdAt } });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Chef", color: "test" },
    });
    await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const chatId = await system.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: { spaceId: id, userId: id, historyCompactionSummary: "Garden talk." },
        select: { id: true },
      });
      await tx.$executeRaw`
        INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name)
        VALUES (${thread.id}, ${bot.id}, ${id}, 'Garden')`;
      return thread.id;
    });
    await system.message.create({
      data: { threadId: chatId, seq: 0, role: "user", blocks: [{ kind: "text", text: "Seeds?" }] },
    });
    await system.message.create({
      data: {
        threadId: chatId,
        seq: 1,
        role: "bot",
        botId: bot.id,
        blocks: [{ kind: "text", text: "Tomatoes." }],
      },
    });
    const records: ContentExportRecord[] = [];
    for await (const record of exportContent(system, { spaceId: id, botId: bot.id }))
      records.push(record);
    const texts = records.flatMap((record) =>
      record.type === "message" && record.threadId === chatId ? [record.text] : [],
    );
    expect(texts).toEqual(["Seeds?", "Tomatoes."]);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "thread",
        id: chatId,
        historyCompactionSummary: "Garden talk.",
      }),
    );
  });
});
