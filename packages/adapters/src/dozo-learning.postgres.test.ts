import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadMessage, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LearningReviewDeps } from "./dozo-learning-review.js";
import { reviewLearning } from "./dozo-learning-review.js";
import {
  consumeLearningTurns,
  findLearningChange,
  learnedLines,
  learningMode,
  listLearningChanges,
  markLearningChangeUndone,
  pendingLearningTurns,
  recordLearningTurn,
  saveLearningChanges,
  setLearningMode,
} from "./dozo-learning-store.js";

// Runs on the branded tree only, against a migrated database (dozo/docker/postgres-tests.sh, in
// UTC and two other zones): DATABASE_URL is the runtime login, which row security applies to.
// The fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("bot learning (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];

  async function member() {
    const id = `learning-${randomUUID()}`;
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
    return { userId: id, spaceId };
  }
  type Member = Awaited<ReturnType<typeof member>>;

  async function bot(owner: Member) {
    const created = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: created.id },
    });
    return { id: created.id, spaceId: owner.spaceId, userId: owner.userId, threadId: thread.id };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  /** One finished turn of the owner's chat: their message, the run it started, the reply. */
  async function turn(owner: Member, chat: Bot, said: string) {
    const message = await createThreadMessage(system, {
      threadId: chat.threadId,
      role: "user",
      authorUserId: owner.userId,
      blocks: [{ kind: "text", text: said }],
    });
    const task = await system.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: chat.id,
        threadId: chat.threadId,
        prompt: said,
        status: "completed",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: chat.id,
        threadId: chat.threadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        sourceMessageId: message.id,
      },
    });
    return { runId: run.id, messageId: message.id };
  }

  const as = <T>(owner: Member, work: () => Promise<T>) => runAsTenant(owner, work);
  const record = (owner: Member, chat: Bot, recorded: { runId: string; messageId: string }) =>
    as(owner, () =>
      recordLearningTurn(prisma, {
        botId: chat.id,
        spaceId: chat.spaceId,
        threadId: chat.threadId,
        tainted: false,
        ...recorded,
      }),
    );

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = () => db.pool.end();
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  it("keeps a bot off until its mode is set, and drops waiting turns when turned off", async () => {
    const owner = await member();
    const chat = await bot(owner);
    expect(await as(owner, () => learningMode(prisma, chat.id))).toBe("off");
    await as(owner, () => setLearningMode(prisma, chat, "auto"));
    expect(await as(owner, () => learningMode(prisma, chat.id))).toBe("auto");
    expect(await record(owner, chat, await turn(owner, chat, "Hi"))).toBe(1);
    await as(owner, () => setLearningMode(prisma, chat, "off"));
    expect(await as(owner, () => learningMode(prisma, chat.id))).toBe("off");
    expect(await as(owner, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
  });

  it("records a run's turn once, reads the newest oldest first, and consumes older ones too", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const turns = [];
    for (const said of ["one", "two", "three"]) turns.push(await turn(owner, chat, said));
    for (const recorded of turns) await record(owner, chat, recorded);
    expect(await record(owner, chat, turns[0]!)).toBe(3);
    const newest = await as(owner, () => pendingLearningTurns(prisma, chat.id, 2));
    expect(newest.map((read) => read.runId)).toEqual([turns[1]!.runId, turns[2]!.runId]);
    expect(newest[0]).toMatchObject({ threadId: chat.threadId, tainted: false });
    await as(owner, () => consumeLearningTurns(prisma, chat.id, newest));
    expect(await as(owner, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
  });

  it("lists changes newest first with true times, in every zone, and undoes once", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const before = Date.now();
    await as(owner, () =>
      saveLearningChanges(prisma, chat, chat.threadId, [
        { kind: "add", before: null, after: "Call the owner Ada." },
        { kind: "update", before: "Uses metric", after: "Uses metric units" },
      ]),
    );
    const changes = await as(owner, () => listLearningChanges(prisma, chat.id, 20));
    expect(changes.map((change) => change.after)).toEqual([
      "Uses metric units",
      "Call the owner Ada.",
    ]);
    for (const change of changes) {
      expect(Math.abs(Date.parse(change.createdAt) - before)).toBeLessThan(60_000);
    }
    const [newest] = changes;
    expect(await as(owner, () => markLearningChangeUndone(prisma, newest!.id))).toBe(true);
    expect(await as(owner, () => markLearningChangeUndone(prisma, newest!.id))).toBe(false);
    const undone = await as(owner, () => findLearningChange(prisma, chat.spaceId, newest!.id));
    expect(Math.abs(Date.parse(undone!.undoneAt!) - Date.now())).toBeLessThan(60_000);
    expect(await as(owner, () => learnedLines(prisma, chat.id))).toEqual([
      { id: changes[1]!.id, after: "Call the owner Ada." },
    ]);
  });

  it("counts only the newest live change on a line as the review's own", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const save = (change: Parameters<typeof saveLearningChanges>[3][number]) =>
      as(owner, () => saveLearningChanges(prisma, chat, chat.threadId, [change]));
    const lines = () => as(owner, () => learnedLines(prisma, chat.id));
    await save({ kind: "add", before: null, after: "Uses metric" });
    const [added] = await lines();
    await save({ kind: "update", before: "Uses metric", after: "Uses metric units" });
    const [updated] = await lines();
    // The owner may type "Uses metric" back by hand: it is no longer the review's line.
    expect(await lines()).toEqual([{ id: updated!.id, after: "Uses metric units" }]);
    const replaced = await as(owner, () => findLearningChange(prisma, chat.spaceId, added!.id));
    expect(replaced!.supersededBy).toBe(updated!.id);
    await save({ kind: "remove", before: "Uses metric units", after: null });
    expect(await lines()).toEqual([]);
    // A line written again belongs to the newest change that wrote it.
    await save({ kind: "add", before: null, after: "Likes tea" });
    await save({ kind: "add", before: null, after: "Likes tea" });
    const tea = await lines();
    expect(tea).toHaveLength(1);
    // Undoing the update hands its line back to the change it replaced.
    await as(owner, () => markLearningChangeUndone(prisma, updated!.id));
    const back = await as(owner, () => findLearningChange(prisma, chat.spaceId, added!.id));
    expect(back!.supersededBy).toBeNull();
  });

  it("keeps each Space's learning to itself and goes with the bot", async () => {
    const owner = await member();
    const stranger = await member();
    const chat = await bot(owner);
    await as(owner, () => setLearningMode(prisma, chat, "auto"));
    await record(owner, chat, await turn(owner, chat, "Hi"));
    await as(owner, () =>
      saveLearningChanges(prisma, chat, chat.threadId, [{ kind: "add", before: null, after: "x" }]),
    );
    expect(await as(stranger, () => learningMode(prisma, chat.id))).toBe("off");
    expect(await as(stranger, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
    expect(await as(stranger, () => listLearningChanges(prisma, chat.id, 20))).toEqual([]);
    await system.bot.delete({ where: { id: chat.id } });
    const left = await system.$queryRaw<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM dozo_bot_learning WHERE "botId" = ${chat.id})
        + (SELECT count(*) FROM dozo_learning_turns WHERE "botId" = ${chat.id})
        + (SELECT count(*) FROM dozo_learning_changes WHERE "botId" = ${chat.id}) AS n`;
    expect(Number(left[0]!.n)).toBe(0);
  });

  it("runs one review of a bot at a time across processes", async () => {
    const owner = await member();
    const chat = await bot(owner);
    await as(owner, () => setLearningMode(prisma, chat, "auto"));
    await record(owner, chat, await turn(owner, chat, "Call me Ada, not Adeline."));
    const answering = deferred<void>();
    const asked = deferred<void>();
    const requests: AgentRunRequest[] = [];
    const notes = { content: "", revision: 0 };
    const deps: LearningReviewDeps = {
      prisma,
      runtime: {
        describe: () => ({ capabilities: { compaction: true } }) as never,
        abort: async () => undefined,
        async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
          requests.push(request);
          asked.resolve();
          await answering.promise;
          yield { type: "done", text: '{"changes":[{"op":"add","text":"Call the owner Ada."}]}' };
        },
      },
      memory: {
        read: vi.fn(async () => ({
          documents: notes.revision
            ? [{ id: "d", path: "MEMORY.md", content: notes.content, revision: notes.revision }]
            : [],
        })),
        commit: vi.fn(async (request) => {
          notes.content = request.content;
          notes.revision += 1;
          return { id: "d", path: "MEMORY.md", revision: notes.revision, content: notes.content };
        }),
      },
      // The owner saved nothing, so there is nothing to open.
      secretStore: { load: vi.fn() },
      resolveModel: async () => ({ provider: "test", id: "own" }) as never,
      resolveConnectedModel: async () => ({ provider: "test", id: "role" }) as never,
    };
    const first = as(owner, () => reviewLearning(deps, chat.id));
    await asked.promise;
    // A second process finds the bot under review and leaves it.
    await as(owner, () => reviewLearning(deps, chat.id));
    expect(requests).toHaveLength(1);
    answering.resolve();
    await first;
    expect(notes.content).toBe("Call the owner Ada.\n");
    expect(await as(owner, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
    const changes = await as(owner, () => listLearningChanges(prisma, chat.id, 20));
    expect(changes).toEqual([
      expect.objectContaining({ kind: "add", after: "Call the owner Ada." }),
    ]);
  });
});
