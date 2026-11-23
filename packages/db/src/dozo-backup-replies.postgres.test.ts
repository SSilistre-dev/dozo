import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { readBackupReplies, recordBackupReply } from "./dozo-backup-replies.js";
import { asSystem, runAsTenant } from "./row-security.js";

// Runs against a migrated database only; the fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("the runs a backup answered (PostgreSQL)", () => {
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

  /** A Space with a bot, its chat, and one run with its reply. */
  async function chat() {
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
    const thread = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await system.task.create({
      data: {
        spaceId: id,
        botId: bot.id,
        threadId: thread.id,
        userId: id,
        prompt: "Hi",
        status: "completed",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        status: "completed",
        trigger: "user",
      },
    });
    const reply = await system.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "bot",
        botId: bot.id,
        runId: run.id,
        blocks: [{ kind: "text", text: "Hello." }],
      },
    });
    const as = <T>(work: () => Promise<T>) => runAsTenant({ spaceId: id, userId: id }, work);
    return { id, threadId: thread.id, runId: run.id, replyId: reply.id, as };
  }

  it("records, moves and clears what a run was answered by, read by its replies", async () => {
    const home = await chat();
    expect(await home.as(() => readBackupReplies(prisma, home.threadId, home.id))).toEqual([]);
    await home.as(() =>
      recordBackupReply(prisma, { id: home.runId }, { provider: "p", modelId: "first" }),
    );
    await home.as(() =>
      recordBackupReply(prisma, { id: home.runId }, { provider: "q", modelId: "second" }),
    );
    expect(await home.as(() => readBackupReplies(prisma, home.threadId, home.id))).toEqual([
      { messageId: home.replyId, provider: "q", modelId: "second" },
    ]);
    await home.as(() => recordBackupReply(prisma, { id: home.runId }, null));
    expect(await home.as(() => readBackupReplies(prisma, home.threadId, home.id))).toEqual([]);
  });

  it("tells only the person whose run it was, not another member of a shared chat", async () => {
    const home = await chat();
    const other = randomUUID();
    ids.push(other);
    await system.user.create({
      data: { id: other, name: "Ben", email: `${other}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: {
        id: `m-${other}`,
        organizationId: home.id,
        userId: other,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: home.id,
        organizationId: home.id,
        userId: other,
        createdAt: new Date(),
      },
    });
    await home.as(() =>
      recordBackupReply(prisma, { id: home.runId }, { provider: "p", modelId: "their-own-model" }),
    );
    const asOther = <T>(work: () => Promise<T>) =>
      runAsTenant({ spaceId: home.id, userId: other }, work);
    expect(await asOther(() => readBackupReplies(prisma, home.threadId, other))).toEqual([]);
    expect(await home.as(() => readBackupReplies(prisma, home.threadId, home.id))).toHaveLength(1);
  });

  it("shows a chat's backups to its own Space only, and goes with its run", async () => {
    const home = await chat();
    const away = await chat();
    await home.as(() =>
      recordBackupReply(prisma, { id: home.runId }, { provider: "p", modelId: "m" }),
    );
    expect(await away.as(() => readBackupReplies(prisma, home.threadId, away.id))).toEqual([]);
    await system.message.deleteMany({ where: { runId: home.runId } });
    await system.run.delete({ where: { id: home.runId } });
    const rows = await system.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "dozo_backup_replies" WHERE "runId" = ${home.runId}`;
    expect(rows).toEqual([{ n: 0 }]);
  });
});
