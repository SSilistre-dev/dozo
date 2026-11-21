import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  groupUsage,
  readDayCells,
  readPersonCells,
  readUsageCells,
} from "./dozo-usage-breakdown.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("the usage breakdown query (PostgreSQL)", () => {
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
      await system.usageRecord.deleteMany({ where: { userId: { in: users } } });
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
    }
    await db?.pool.end();
  });

  async function person(): Promise<Actor> {
    const id = `usage-breakdown-${randomUUID()}`;
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

  async function bot(actor: Actor, name: string) {
    const created = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: created.id } });
    return { id: created.id, threadId: thread.id };
  }

  async function run(actor: Actor, owner: { id: string; threadId: string }, routineId?: string) {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: owner.id,
        threadId: owner.threadId,
        prompt: "Work",
        status: "completed",
      },
    });
    return system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: owner.id,
        threadId: owner.threadId,
        taskId: task.id,
        status: "completed",
        trigger: routineId ? "routine" : "user",
        routineId,
      },
    });
  }

  function usage(
    actor: Actor,
    more: {
      botId?: string;
      runId?: string;
      parentRunId?: string;
      costUsd?: number | null;
      createdAt?: Date;
    },
  ) {
    return system.usageRecord.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        provider: "test-provider",
        model: "small",
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        costUsd: 0.25,
        ...more,
      },
    });
  }

  it("names bots and routines, keeps deleted bots, and tells unknown from none", async () => {
    const ada = await person();
    const chef = await bot(ada, "Chef");
    const digest = await system.routine.create({
      data: {
        spaceId: ada.spaceId,
        botId: chef.id,
        userId: ada.userId,
        name: "Morning digest",
        prompt: "Summarise",
        crons: ["0 8 * * *"],
      },
    });
    const gone = await system.routine.create({
      data: {
        spaceId: ada.spaceId,
        botId: chef.id,
        userId: ada.userId,
        name: "Gone",
        prompt: "Summarise",
        crons: ["0 9 * * *"],
      },
    });
    const routineRun = await run(ada, chef, digest.id);
    const goneRun = await run(ada, chef, gone.id);
    const chatRun = await run(ada, chef);
    // A sub-agent's record names its own run and the routine's run as its parent.
    await usage(ada, { botId: chef.id, runId: routineRun.id });
    await usage(ada, { botId: chef.id, runId: chatRun.id, parentRunId: routineRun.id });
    await usage(ada, { botId: chef.id, runId: chatRun.id, costUsd: null });
    await usage(ada, { botId: chef.id, runId: goneRun.id });
    await system.routine.delete({ where: { id: gone.id } });
    const deletedBot = `bot-${randomUUID()}`;
    // A deleted bot: its id stays on the record and its name in the deletions.
    await system.botDeletion.create({
      data: {
        id: deletedBot,
        spaceId: ada.spaceId,
        name: "Old helper",
        deletedByUserId: ada.userId,
        memoriesPreserved: false,
      },
    });
    await usage(ada, { botId: deletedBot, runId: "run-gone" });
    await usage(ada, {});
    // Someone else's spend in another Space never shows.
    const bob = await person();
    await usage(bob, { costUsd: 99 });

    const cells = await runAsTenant(ada, () => readUsageCells(prisma, ada));
    const pick = (by: "model" | "bot" | "routine") =>
      groupUsage(cells, by).map((g) => [g.name, g.detail, g.state, g.modelCalls, g.costUsd]);
    expect(pick("model")).toEqual([["small", "test-provider", "live", 6, null]]);
    expect(pick("bot")).toEqual([
      ["Old helper", null, "deleted", 1, 0.25],
      [null, null, "none", 1, 0.25],
      ["Chef", null, "live", 4, null],
    ]);
    expect(pick("routine")).toEqual([
      ["Morning digest", "Chef", "live", 2, 0.5],
      [null, null, "unknown", 2, 0.5],
      [null, null, "none", 2, null],
    ]);
  });

  it("cuts days at the account's midnight whatever zone the database runs in", async () => {
    const ada = await person();
    const at = (iso: string) => usage(ada, { createdAt: new Date(iso) });
    await at("2026-11-20T20:59:59Z");
    await at("2026-11-20T21:00:00Z");
    await at("2026-11-21T07:59:59Z");
    await at("2026-11-21T08:00:00Z");
    // Before the 30 days, so never shown.
    await at("2026-10-01T12:00:00Z");
    const now = new Date("2026-11-21T09:00:00Z");
    const days = async (zone: string) =>
      groupUsage(await runAsTenant(ada, () => readDayCells(prisma, ada, zone, now)), "day").map(
        (g) => [g.key, g.modelCalls],
      );
    expect(await days("Europe/Istanbul")).toEqual([
      ["2026-11-21", 3],
      ["2026-11-20", 1],
    ]);
    expect(await days("UTC")).toEqual([
      ["2026-11-21", 2],
      ["2026-11-20", 2],
    ]);
    expect(await days("America/Los_Angeles")).toEqual([
      ["2026-11-21", 1],
      ["2026-11-20", 3],
    ]);
  });

  it("gives an empty period no days", async () => {
    const ada = await person();
    await usage(ada, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const now = new Date("2026-11-21T09:00:00Z");
    expect(await runAsTenant(ada, () => readDayCells(prisma, ada, "UTC", now))).toEqual([]);
  });

  it("reads every member of the Space for the person grouping, and no other Space", async () => {
    const ada = await person();
    const bobId = `usage-breakdown-${randomUUID()}`;
    users.push(bobId);
    const createdAt = new Date();
    await system.user.create({
      data: { id: bobId, name: "Bob", email: `${bobId}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: {
        id: `m-${bobId}`,
        organizationId: ada.userId,
        userId: bobId,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: ada.spaceId,
        organizationId: ada.userId,
        userId: bobId,
        role: "member",
        createdAt,
      },
    });
    const bob: Actor = { ...ada, userId: bobId, email: `${bobId}@example.test` };
    await usage(ada, { costUsd: 1 });
    await usage(bob, { costUsd: 3 });
    const carol = await person();
    await usage(carol, { costUsd: 99 });

    const cells = await runAsTenant(ada, () => readPersonCells(prisma, ada.spaceId));
    expect(
      groupUsage(cells, "person").map((g) => [
        g.name,
        g.detail?.endsWith("@example.test"),
        g.costUsd,
      ]),
    ).toEqual([
      ["Bob", true, 3],
      ["Ada", true, 1],
    ]);
  });
});
