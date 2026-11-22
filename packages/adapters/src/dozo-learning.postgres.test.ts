import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadMessage, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { learningWriteLanded } from "./dozo-learning-apply.js";
import type { LearningReviewDeps } from "./dozo-learning-review.js";
import { learningAvailable, reviewLearning } from "./dozo-learning-review.js";
import type { LearningChangeInput } from "./dozo-learning-store.js";
import {
  consumeLearningTurns,
  findLearningChange,
  LEARNING_REVIEWS_PER_DAY,
  LEARNING_TURNS_KEPT,
  learnedLines,
  learningMode,
  listLearningChanges,
  markLearningLinesOwnerEdited,
  markLearningUndoPending,
  pendingLearningTurns,
  pendingLearningWrites,
  recordLearningTurn,
  rejectedLearningLines,
  saveLearningChanges,
  setLearningMode,
  settleLearningWrite,
  takeLearningReview,
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
        botReplyReadable: true,
        ...recorded,
      }),
    );
  /** Changes a review made and wrote: recorded pending, then settled as landed. */
  const applied = async (
    owner: Member,
    chat: Bot,
    changes: LearningChangeInput[],
    source: { threadId: string | null; messageId: string | null } = {
      threadId: chat.threadId,
      messageId: null,
    },
  ) => {
    const tag = `dozo-learning:${randomUUID()}`;
    await as(owner, () => saveLearningChanges(prisma, chat, source, changes, tag));
    await as(owner, () => settleLearningWrite(prisma, tag, true));
  };
  /** An undo that wrote the notes: marked pending, then settled as landed. */
  const undo = async (owner: Member, changeId: string) => {
    const tag = `dozo-learning:${randomUUID()}`;
    if (!(await as(owner, () => markLearningUndoPending(prisma, changeId, tag)))) return false;
    await as(owner, () => settleLearningWrite(prisma, tag, true));
    return true;
  };

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
    expect(newest[0]).toMatchObject({ threadId: chat.threadId, botReplyReadable: true });
    await as(owner, () => consumeLearningTurns(prisma, chat.id, newest));
    expect(await as(owner, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
  });

  it("keeps only the bot's newest waiting turns while no review reads them", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const other = await bot(owner);
    await record(owner, other, await turn(owner, other, "elsewhere"));
    const oldest = await turn(owner, chat, "first");
    await record(owner, chat, oldest);
    // Older for certain, whatever the clock's resolution: compared as timestamptz in every zone.
    await system.$executeRaw`
      UPDATE dozo_learning_turns SET "createdAt" = CURRENT_TIMESTAMP - interval '1 hour'
      WHERE "runId" = ${oldest.runId}`;
    let pending = 0;
    for (let index = 1; index <= LEARNING_TURNS_KEPT; index += 1)
      pending = await record(owner, chat, await turn(owner, chat, `turn ${index}`));
    expect(pending).toBe(LEARNING_TURNS_KEPT);
    const kept = await as(owner, () => pendingLearningTurns(prisma, chat.id, 1000));
    expect(kept).toHaveLength(LEARNING_TURNS_KEPT);
    expect(kept.map((read) => read.runId)).not.toContain(oldest.runId);
    expect(await as(owner, () => pendingLearningTurns(prisma, other.id, 10))).toHaveLength(1);
  });

  it("lists changes newest first with true times, in every zone, and undoes once", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const before = Date.now();
    await applied(owner, chat, [
      { kind: "add", before: null, after: "Call the owner Ada." },
      { kind: "update", before: "Uses metric", after: "Uses metric units" },
    ]);
    const changes = await as(owner, () => listLearningChanges(prisma, chat.id, 20));
    expect(changes.map((change) => change.after)).toEqual([
      "Uses metric units",
      "Call the owner Ada.",
    ]);
    for (const change of changes) {
      expect(Math.abs(Date.parse(change.createdAt) - before)).toBeLessThan(60_000);
    }
    const [newest] = changes;
    expect(await undo(owner, newest!.id)).toBe(true);
    expect(await undo(owner, newest!.id)).toBe(false);
    const undone = await as(owner, () => findLearningChange(prisma, chat.spaceId, newest!.id));
    expect(Math.abs(Date.parse(undone!.undoneAt!) - Date.now())).toBeLessThan(60_000);
    expect(await as(owner, () => learnedLines(prisma, chat.id))).toEqual([
      { id: changes[1]!.id, after: "Call the owner Ada." },
    ]);
  });

  it("counts only the newest live change on a line as the review's own", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const save = (change: LearningChangeInput) => applied(owner, chat, [change]);
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
    await undo(owner, updated!.id);
    const back = await as(owner, () => findLearningChange(prisma, chat.spaceId, added!.id));
    expect(back!.supersededBy).toBeNull();
  });

  it("keeps each Space's learning to itself and goes with the bot", async () => {
    const owner = await member();
    const stranger = await member();
    const chat = await bot(owner);
    await as(owner, () => setLearningMode(prisma, chat, "auto"));
    await record(owner, chat, await turn(owner, chat, "Hi"));
    await applied(owner, chat, [{ kind: "add", before: null, after: "x" }]);
    expect(await as(owner, () => takeLearningReview(prisma, chat))).toBe(true);
    expect(await as(stranger, () => learningMode(prisma, chat.id))).toBe("off");
    expect(await as(stranger, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
    expect(await as(stranger, () => listLearningChanges(prisma, chat.id, 20))).toEqual([]);
    await system.bot.delete({ where: { id: chat.id } });
    const left = await system.$queryRaw<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM dozo_bot_learning WHERE "botId" = ${chat.id})
        + (SELECT count(*) FROM dozo_learning_turns WHERE "botId" = ${chat.id})
        + (SELECT count(*) FROM dozo_learning_changes WHERE "botId" = ${chat.id})
        + (SELECT count(*) FROM dozo_learning_reviews WHERE "botId" = ${chat.id}) AS n`;
    expect(Number(left[0]!.n)).toBe(0);
  });

  it("runs one review of a bot at a time across processes", async () => {
    const owner = await member();
    const chat = await bot(owner);
    await as(owner, () => setLearningMode(prisma, chat, "auto"));
    for (const said of ["Call me Ada, not Adeline.", "Thanks", "Shorter, please"])
      await record(owner, chat, await turn(owner, chat, said));
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
          yield {
            type: "done",
            text: '{"changes":[{"op":"add","kind":"preference","text":"Call the owner Ada."}]}',
          };
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
      secretStore: { load: vi.fn() } as never,
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
  it("gives a bot six reviews in any day, in every zone", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const other = await bot(owner);
    const take = (target: Bot) => as(owner, () => takeLearningReview(prisma, target));
    for (let index = 0; index < LEARNING_REVIEWS_PER_DAY; index += 1)
      expect(await take(chat)).toBe(true);
    expect(await take(chat)).toBe(false);
    expect(await take(other)).toBe(true);
    // One taken just over a day ago no longer counts; one just under a day ago still does.
    await system.$executeRaw`
      UPDATE dozo_learning_reviews SET "createdAt" = CURRENT_TIMESTAMP - interval '23 hours 59 minutes'
      WHERE "botId" = ${chat.id}`;
    expect(await take(chat)).toBe(false);
    await system.$executeRaw`
      UPDATE dozo_learning_reviews SET "createdAt" = CURRENT_TIMESTAMP - interval '1 day 1 minute'
      WHERE id = (SELECT id FROM dozo_learning_reviews WHERE "botId" = ${chat.id} LIMIT 1)`;
    expect(await take(chat)).toBe(true);
    expect(await take(chat)).toBe(false);
  });

  it("settles a write left pending: landed, or rolled back with the lines it took handed back", async () => {
    const owner = await member();
    const chat = await bot(owner);
    await applied(owner, chat, [{ kind: "add", before: null, after: "Uses metric" }]);
    const [first] = await as(owner, () => learnedLines(prisma, chat.id));
    const tag = `dozo-learning:${randomUUID()}`;
    await as(owner, () =>
      saveLearningChanges(
        prisma,
        chat,
        { threadId: chat.threadId, messageId: null },
        [{ kind: "update", before: "Uses metric", after: "Uses metric units" }],
        tag,
      ),
    );
    // Listed while pending: no window where a written line is not.
    expect((await as(owner, () => listLearningChanges(prisma, chat.id, 20))).length).toBe(2);
    const writes = (options: { reviews: boolean; olderThanMs: number }) =>
      as(owner, () => pendingLearningWrites(prisma, chat.id, options));
    expect(await writes({ reviews: true, olderThanMs: 60_000 })).toEqual([tag]);
    expect(await writes({ reviews: false, olderThanMs: 60_000 })).toEqual([]);
    await system.$executeRaw`
      UPDATE dozo_learning_changes SET "pendingSince" = CURRENT_TIMESTAMP - interval '2 minutes'
      WHERE "pendingTag" = ${tag}`;
    expect(await writes({ reviews: false, olderThanMs: 60_000 })).toEqual([tag]);
    await as(owner, () => settleLearningWrite(prisma, tag, false));
    expect(await as(owner, () => listLearningChanges(prisma, chat.id, 20))).toHaveLength(1);
    expect(await as(owner, () => learnedLines(prisma, chat.id))).toEqual([first]);
    expect(await writes({ reviews: true, olderThanMs: 0 })).toEqual([]);
    // An undo that did not land leaves the change as it was.
    const undoTag = `dozo-learning:${randomUUID()}`;
    expect(await as(owner, () => markLearningUndoPending(prisma, first!.id, undoTag))).toBe(true);
    expect(await as(owner, () => markLearningUndoPending(prisma, first!.id, "again"))).toBe(false);
    await as(owner, () => settleLearningWrite(prisma, undoTag, false));
    const kept = await as(owner, () => findLearningChange(prisma, chat.spaceId, first!.id));
    expect(kept).toMatchObject({ undoneAt: null, pending: null });
  });

  it("turns down undone lines and lines the owner edited, newest first", async () => {
    const owner = await member();
    const chat = await bot(owner);
    await applied(owner, chat, [
      { kind: "add", before: null, after: "Undone first" },
      { kind: "add", before: null, after: "Edited later" },
      { kind: "add", before: null, after: "Still mine" },
      { kind: "remove", before: "A removed line", after: null },
    ]);
    const lines = await as(owner, () => learnedLines(prisma, chat.id));
    const id = (after: string) => lines.find((line) => line.after === after)!.id;
    await undo(owner, id("Undone first"));
    await system.$executeRaw`
      UPDATE dozo_learning_changes SET "undoneAt" = CURRENT_TIMESTAMP - interval '1 hour'
      WHERE id = ${id("Undone first")}`;
    await as(owner, () => markLearningLinesOwnerEdited(prisma, [id("Edited later")]));
    expect(await as(owner, () => rejectedLearningLines(prisma, chat.id))).toEqual([
      "Edited later",
      "Undone first",
    ]);
    expect(await as(owner, () => learnedLines(prisma, chat.id))).toEqual([
      { id: id("Still mine"), after: "Still mine" },
    ]);
    const edited = await as(owner, () =>
      findLearningChange(prisma, chat.spaceId, id("Edited later")),
    );
    expect(edited!.ownerEdited).toBe(true);
  });

  it("forgets the changes learned from a chat when its messages or the chat are deleted", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const said = await turn(owner, chat, "Call me Ada");
    await applied(owner, chat, [{ kind: "add", before: null, after: "Call the owner Ada." }], {
      threadId: chat.threadId,
      messageId: said.messageId,
    });
    await applied(owner, chat, [{ kind: "add", before: null, after: "From elsewhere" }]);
    await system.message.delete({ where: { id: said.messageId } });
    const left = await as(owner, () => listLearningChanges(prisma, chat.id, 20));
    expect(left.map((change) => change.after)).toEqual(["From elsewhere"]);
    await system.thread.delete({ where: { id: chat.threadId } });
    expect(await as(owner, () => listLearningChanges(prisma, chat.id, 20))).toEqual([]);
  });

  it("keeps a line the owner turned down after the chat it came from is deleted, and only that", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const said = await turn(owner, chat, "Call me Ada");
    await applied(
      owner,
      chat,
      [
        { kind: "add", before: null, after: "Call the owner Ada." },
        { kind: "add", before: null, after: "Likes tea" },
        { kind: "add", before: null, after: "Kept as learned" },
      ],
      { threadId: chat.threadId, messageId: said.messageId },
    );
    const lines = await as(owner, () => learnedLines(prisma, chat.id));
    const id = (after: string) => lines.find((line) => line.after === after)!.id;
    await undo(owner, id("Call the owner Ada."));
    await as(owner, () => markLearningLinesOwnerEdited(prisma, [id("Likes tea")]));
    await system.thread.delete({ where: { id: chat.threadId } });
    expect(await as(owner, () => listLearningChanges(prisma, chat.id, 20))).toEqual([]);
    expect(await as(owner, () => rejectedLearningLines(prisma, chat.id))).toEqual([
      "Likes tea",
      "Call the owner Ada.",
    ]);
    // Nothing else of the chat stays: no thread, message or other line beside the turned-down text.
    const kept = await system.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM dozo_learning_rejections WHERE "botId" = ${chat.id}`;
    expect(Object.keys(kept[0]!).sort()).toEqual(["botId", "createdAt", "id", "spaceId", "text"]);
    // A second member's Space never sees them, and they go with the bot.
    const stranger = await member();
    expect(await as(stranger, () => rejectedLearningLines(prisma, chat.id))).toEqual([]);
    await system.bot.delete({ where: { id: chat.id } });
    const gone = await system.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM dozo_learning_rejections WHERE "botId" = ${chat.id}`;
    expect(gone[0]!.n).toBe(0);
  });

  it("tells whether a tagged write reached the bot's notes", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const other = await bot(owner);
    const tag = `dozo-learning:${randomUUID()}`;
    const document = await system.memoryDocument.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: chat.id,
        scope: "bot",
        path: "MEMORY.md",
        content: "x\n",
      },
    });
    await system.memoryRevision.create({
      data: { documentId: document.id, revision: 1, content: "x\n", sourceRunId: tag },
    });
    expect(await as(owner, () => learningWriteLanded(prisma, chat, tag))).toBe(true);
    expect(await as(owner, () => learningWriteLanded(prisma, chat, "dozo-learning:other"))).toBe(
      false,
    );
    expect(await as(owner, () => learningWriteLanded(prisma, other, tag))).toBe(false);
  });

  it("offers learning only while nobody else is in the bot's Space", async () => {
    const owner = await member();
    const chat = await bot(owner);
    expect(await as(owner, () => learningAvailable(prisma, chat))).toBe(true);
    const guest = await member();
    const organizationId = owner.userId;
    await system.member.create({
      data: {
        id: `m2-${guest.userId}`,
        organizationId,
        userId: guest.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: owner.spaceId,
        organizationId,
        userId: guest.userId,
        role: "guest",
        createdAt: new Date(),
      },
    });
    expect(await as(owner, () => learningAvailable(prisma, chat))).toBe(false);
  });

  it("turns learning off for good in a Space someone else joins, however they join", async () => {
    const owner = await member();
    const chat = await bot(owner);
    const elsewhere = await bot(await member());
    for (const learning of [chat, elsewhere])
      await system.$executeRaw`
        INSERT INTO dozo_bot_learning ("botId", "spaceId", mode)
        VALUES (${learning.id}, ${learning.spaceId}, 'auto')`;
    await record(owner, chat, await turn(owner, chat, "Call me Ada"));
    const guest = await member();
    const organizationId = owner.userId;
    // Joining through the app's own path (an invite), in the runtime login's own transaction.
    await system.member.create({
      data: {
        id: `m3-${guest.userId}`,
        organizationId,
        userId: guest.userId,
        role: "guest",
        createdAt: new Date(),
      },
    });
    const joined = randomUUID();
    await runAsTenant(guest, () =>
      prisma.spaceMember.create({
        data: {
          id: joined,
          spaceId: owner.spaceId,
          organizationId,
          userId: guest.userId,
          role: "member",
          createdAt: new Date(),
        },
      }),
    );
    expect(await as(owner, () => learningMode(prisma, chat.id))).toBe("off");
    expect(await as(owner, () => pendingLearningTurns(prisma, chat.id, 10))).toEqual([]);
    // Another Space's bot keeps learning.
    expect(await system.$queryRaw`SELECT mode FROM dozo_bot_learning WHERE "botId" = ${elsewhere.id}`)
      .toEqual([{ mode: "auto" }]);
    // The owner turns it on again only once they are alone again.
    await system.spaceMember.delete({ where: { id: joined } });
    expect(await as(owner, () => learningMode(prisma, chat.id))).toBe("off");
  });
});
