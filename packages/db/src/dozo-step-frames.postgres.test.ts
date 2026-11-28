import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./database/client.js";
import { createDb } from "./database/client.js";
import { asSystem, runAsSystem } from "./database/row-security.js";
import { withSharedSpace } from "./dozo-shared-space.js";
import {
  holdStepFrame,
  STEP_FRAME_KEPT,
  STEP_FRAME_PENDING,
  STEP_FRAMES_BOT_BYTES,
  settleStepFrames,
} from "./dozo-step-frames.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const MB = 1024 * 1024;

describePostgres("replay frames (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];
  let files = 0;

  async function owner() {
    const id = `step-frames-${randomUUID()}`;
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
    const bot = await system.bot.create({
      data: { spaceId, userId: id, name: "Scout", color: "slate" },
    });
    const thread = await system.thread.create({ data: { spaceId, userId: id, botId: bot.id } });
    return { userId: id, spaceId, botId: bot.id, threadId: thread.id, organizationId: id };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;

  async function run(who: Owner, status = "completed") {
    const base = { spaceId: who.spaceId, userId: who.userId, botId: who.botId };
    const task = await system.task.create({
      data: { ...base, threadId: who.threadId, prompt: "go", status },
    });
    const row = await system.run.create({
      data: { ...base, threadId: who.threadId, taskId: task.id, trigger: "user", status },
    });
    return row.id;
  }

  const frameRow = (who: Owner, runId: string, size: number, name: string, createdAt?: Date) =>
    system.artifact.create({
      data: {
        spaceId: who.spaceId,
        userId: who.userId,
        botId: who.botId,
        runId,
        name,
        mimeType: "image/png;profile=step-screenshot",
        size,
        hash: `frame:${runId}:${files}`,
        storageKey: `step-frames-${files++}`,
        ...(createdAt ? { createdAt } : {}),
      },
    });

  /** One extra frame written as the run's frame writer writes it. */
  const write = (who: Owner, runId: string, size: number) =>
    runAsSystem("test: a run writes a frame", () =>
      prisma.$transaction(async (tx) => {
        const held = await holdStepFrame(tx, {
          spaceId: who.spaceId,
          botId: who.botId,
          bytes: size,
        });
        if (!held.allowed) return held;
        await tx.artifact.create({
          data: {
            spaceId: who.spaceId,
            userId: who.userId,
            botId: who.botId,
            runId,
            name: STEP_FRAME_PENDING,
            mimeType: "image/png;profile=step-screenshot",
            size,
            hash: `frame:${runId}:${files}`,
            storageKey: `step-frames-${files++}`,
          },
        });
        return held;
      }),
    );

  const frames = (who: Owner) =>
    system.artifact.findMany({
      where: { botId: who.botId },
      select: { runId: true, name: true },
      orderBy: { createdAt: "asc" },
    });

  async function liveLink(who: Owner, runId: string) {
    const message = await system.message.create({
      data: {
        threadId: who.threadId,
        seq: files++,
        role: "bot",
        botId: who.botId,
        runId,
        blocks: [],
      },
    });
    const replayId = randomUUID();
    await system.$executeRaw`
      INSERT INTO dozo_replays ("id", "userId", "spaceId", "botId", "messageId", "steps", "fingerprint")
      VALUES (${replayId}, ${who.userId}, ${who.spaceId}, ${who.botId}, ${message.id}, '[]'::jsonb, 'x')`;
    await system.$executeRaw`
      INSERT INTO dozo_share_links ("id", "userId", "spaceId", "kind", "targetId", "tokenHash", "expiresAt")
      VALUES (${randomUUID()}, ${who.userId}, ${who.spaceId}, 'replay', ${replayId}, ${randomUUID()},
        ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz)`;
  }

  const bills = (modelCreditsEnabled: boolean) =>
    system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled },
      update: { modelCreditsEnabled },
    });

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await bills(false);
    await close();
  });

  it("removes the frames of the bot's oldest reply first, never a reply's last screenshot", async () => {
    const ada = await owner();
    const [oldest, older, newer] = [await run(ada), await run(ada), await run(ada)];
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await frameRow(ada, oldest, 20 * MB, STEP_FRAME_KEPT, at(30));
    await frameRow(ada, oldest, 2 * MB, "screenshot", at(30));
    await frameRow(ada, older, 20 * MB, STEP_FRAME_KEPT, at(20));
    await frameRow(ada, newer, 9 * MB, STEP_FRAME_KEPT, at(10));
    const current = await run(ada, "running");
    expect((await write(ada, current, 2 * MB)).allowed).toBe(true);
    expect(await frames(ada)).toEqual([
      { runId: oldest, name: "screenshot" },
      { runId: older, name: STEP_FRAME_KEPT },
      { runId: newer, name: STEP_FRAME_KEPT },
      { runId: current, name: STEP_FRAME_PENDING },
    ]);
  });

  it("never removes the frames of a reply with a live replay link", async () => {
    const ada = await owner();
    const [linked, other] = [await run(ada), await run(ada)];
    await frameRow(ada, linked, 30 * MB, STEP_FRAME_KEPT, new Date(Date.now() - 60_000));
    await frameRow(ada, other, 20 * MB, STEP_FRAME_KEPT);
    await liveLink(ada, linked);
    const current = await run(ada, "running");
    expect((await write(ada, current, MB)).allowed).toBe(true);
    const left = (await frames(ada)).map((row) => row.runId);
    expect(left).toContain(linked);
    expect(left).not.toContain(other);
    // With only the linked reply left to remove, there is no room and nothing is removed.
    expect((await write(ada, current, 25 * MB)).allowed).toBe(false);
    expect((await frames(ada)).map((row) => row.runId)).toContain(linked);
  });

  it("never lets extra frames take the last tenth of the organization's shared space", async () => {
    await bills(true);
    try {
      const ada = await owner();
      const big = await run(ada);
      await system.artifact.create({
        data: {
          spaceId: ada.spaceId,
          userId: ada.userId,
          name: "upload",
          mimeType: "text/plain",
          size: 449 * MB,
          hash: "h",
          storageKey: `step-frames-${files++}`,
          runId: big,
        },
      });
      const current = await run(ada, "running");
      expect((await write(ada, current, MB / 2)).allowed).toBe(true);
      expect((await write(ada, current, MB)).allowed).toBe(false);
    } finally {
      await bills(false);
    }
  });

  it("keeps a failing routine's frames from piling up: each run's pending frames go with the next", async () => {
    const ada = await owner();
    for (let attempt = 0; attempt < 5; attempt++) {
      const runId = await run(ada, "running");
      for (let shot = 0; shot < 3; shot++) await write(ada, runId, MB);
      await system.run.update({ where: { id: runId }, data: { status: "failed" } });
    }
    const left = await frames(ada);
    expect(left.length).toBeLessThanOrEqual(3);
    expect(new Set(left.map((row) => row.runId)).size).toBe(1);
  });

  it("keeps a running reply's pending frames while another run of the bot writes", async () => {
    const ada = await owner();
    const paused = await run(ada, "running");
    await write(ada, paused, MB);
    await write(ada, await run(ada, "running"), MB);
    expect((await frames(ada)).map((row) => row.runId)).toContain(paused);
  });

  it("settles a reply: keeps its linked frames, removes its others, and never another run's", async () => {
    const ada = await owner();
    const [mine, theirs] = [await run(ada, "running"), await run(ada, "running")];
    // The same screenshot in two runs is two rows, each with a file of its own.
    const kept = await frameRow(ada, mine, MB, STEP_FRAME_PENDING);
    await frameRow(ada, mine, MB, STEP_FRAME_PENDING);
    const same = await frameRow(ada, theirs, MB, STEP_FRAME_PENDING);
    const removed = await runAsSystem("test: a reply settles", () =>
      settleStepFrames(prisma, {
        spaceId: ada.spaceId,
        botId: ada.botId,
        runId: mine,
        linked: [kept.id, same.id],
      }),
    );
    expect(removed).toHaveLength(1);
    const rows = await system.artifact.findMany({
      where: { botId: ada.botId },
      select: { id: true, name: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: kept.id, name: STEP_FRAME_KEPT },
        { id: same.id, name: STEP_FRAME_PENDING },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("delays a reply's last screenshot by at most one frame write while 30 frames are written", async () => {
    await bills(true);
    try {
      const ada = await owner();
      const runId = await run(ada, "running");
      const lastSave = async () => {
        const started = performance.now();
        await runAsSystem("test: a run saves its last screenshot", () =>
          withSharedSpace(prisma, ada.spaceId, (tx: Prisma.TransactionClient) =>
            tx.artifact.create({
              data: {
                spaceId: ada.spaceId,
                userId: ada.userId,
                botId: ada.botId,
                runId,
                name: "screenshot",
                mimeType: "image/png;profile=step-screenshot",
                size: 230 * 1024,
                hash: `last-${files}`,
                storageKey: `step-frames-${files++}`,
              },
            }),
          ),
        );
        return performance.now() - started;
      };
      const alone: number[] = [];
      for (let at = 0; at < 5; at++) alone.push(await lastSave());
      let writer = Promise.resolve();
      const started = performance.now();
      for (let shot = 0; shot < 30; shot++)
        writer = writer.then(async () => {
          await write(ada, runId, 230 * 1024);
        });
      const beside: number[] = [];
      for (let at = 0; at < 5; at++) beside.push(await lastSave());
      await writer;
      const writing = performance.now() - started;
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
      // biome-ignore lint/suspicious/noConsole: the measurement the pull request reports
      console.info(
        `STEP_FRAMES_TIMING last save alone ${median(alone).toFixed(1)} ms, beside the frame writer ${median(beside).toFixed(1)} ms; 30 frames written in ${writing.toFixed(0)} ms`,
      );
      expect(median(beside)).toBeLessThan(median(alone) + 250);
      expect(STEP_FRAMES_BOT_BYTES).toBe(50 * MB);
    } finally {
      await bills(false);
    }
  });
});
