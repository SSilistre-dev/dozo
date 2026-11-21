import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadMessageInTransaction,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compactHistory } from "./history-compaction.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh, which also runs it with the
// database in other time zones than UTC). The fork's unit gate has no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Going back to an earlier message (apps/api/src/dozo-message-revision.ts) removes the messages
 * after it and counts the rewind on the chat. A history summary read before that covers messages
 * that are gone: the summarizer's answer must not land, or the chat's next messages, which take
 * the freed places, would count as summarized and drop out of what the bot reads.
 */
describePostgres("history compaction across a rewind (PostgreSQL)", () => {
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

  async function chat() {
    const id = `compaction-rewind-${randomUUID()}`;
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
    const actor: Actor = {
      userId: id,
      spaceId,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    await system.message.deleteMany({ where: { threadId: thread.id } });
    await system.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 0 } });
    for (const [index, text] of ["Plan dinner", "Pasta.", "Make it vegan", "Lentils."].entries())
      await system.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: index % 2 === 0 ? "user" : "bot",
          ...(index % 2 === 0 ? { authorUserId: id } : { botId: bot.id }),
          blocks: [{ kind: "text", text }],
        }),
      );
    return { actor, threadId: thread.id };
  }

  /** What a rewind to the first message does to the chat's rows, as the revision route does it. */
  async function rewindToFirst(threadId: string) {
    await system.$transaction(async (tx) => {
      await tx.message.deleteMany({ where: { threadId, seq: { gt: 0 } } });
      await tx.thread.update({
        where: { id: threadId },
        data: { nextMessageSeq: 1, dozoRewinds: { increment: 1 } },
      });
    });
  }

  /** A summarizer whose answer comes back after `during` ran. */
  function runtime(during: () => Promise<void>): AgentRuntime {
    return {
      describe: () => ({ capabilities: { compaction: true } }),
      async *run() {
        await during();
        yield { type: "done", text: "They planned a vegan dinner." };
      },
    } as unknown as AgentRuntime;
  }

  const compact = (threadId: string, during: () => Promise<void>) =>
    compactHistory(
      {
        // The worker reads the chat as the system does.
        prisma: system,
        runtime: runtime(during),
        jobs: { enqueue: vi.fn() },
        memoryProviders: { resolve: async () => null },
        resolveModel: async () => ({ provider: "fake", id: "fake-model" }),
      } as unknown as Parameters<typeof compactHistory>[0],
      threadId,
    );

  it("drops a summary read before the chat went back, so the new messages stay in the history", async () => {
    const { threadId } = await chat();
    await compact(threadId, () => rewindToFirst(threadId));
    const thread = await system.thread.findUniqueOrThrow({ where: { id: threadId } });
    expect(thread.historyCompactedUpToSeq).toBeNull();
    expect(thread.historyCompactionSummary).toBeNull();
  });

  it("writes a summary when nothing went back meanwhile", async () => {
    const { threadId } = await chat();
    await compact(threadId, async () => undefined);
    const thread = await system.thread.findUniqueOrThrow({ where: { id: threadId } });
    expect(thread.historyCompactedUpToSeq).toBe(3);
    expect(thread.historyCompactionSummary).toBe("They planned a vegan dinner.");
  });
});
