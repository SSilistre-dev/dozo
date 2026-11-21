import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dozoUsageRoutes } from "./dozo-usage.js";
import {
  groupUsage,
  readDayCells,
  readPersonCells,
  readUsageCells,
} from "./dozo-usage-breakdown.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("the usage breakdown query (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  const users: string[] = [];
  const orgs: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (users.length) {
      await system.usageRecord.deleteMany({ where: { userId: { in: users } } });
      await system.organization.deleteMany({ where: { id: { in: [...users, ...orgs] } } });
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

  /** A new person who belongs to `owner`'s Space as an ordinary member. */
  async function addMember(owner: Actor, name: string): Promise<Actor> {
    const id = `usage-breakdown-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: owner.userId, userId: id, role: "member", createdAt },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: owner.spaceId,
        organizationId: owner.userId,
        userId: id,
        role: "member",
        createdAt,
      },
    });
    return { ...owner, userId: id, email: `${id}@example.test` };
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

  /** The day counts as the account sees them, read in a session set to `sessionZone`. */
  async function days(actor: Actor, zone: string, sessionZone: string, now: Date) {
    const cells = await system.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${sessionZone}, true)`;
      return readDayCells(tx, actor, zone, now);
    });
    return groupUsage(cells, "day").map((g) => [g.key, g.modelCalls]);
  }

  const SESSION_ZONES = ["UTC", "Europe/Istanbul", "America/Los_Angeles"];

  it("cuts days at the account's midnight in every session zone", async () => {
    const ada = await person();
    const at = (iso: string) => usage(ada, { createdAt: new Date(iso) });
    // Each account zone's midnight, a minute either side.
    await at("2026-11-20T20:59:00Z"); // Istanbul: 23:59 on the 20th
    await at("2026-11-20T21:01:00Z"); // Istanbul: 00:01 on the 21st
    await at("2026-11-20T23:59:00Z"); // UTC: the 20th
    await at("2026-11-21T00:01:00Z"); // UTC: the 21st
    await at("2026-11-21T07:59:00Z"); // Los Angeles: 23:59 on the 20th
    await at("2026-11-21T08:01:00Z"); // Los Angeles: 00:01 on the 21st
    // The first day shown, 10-23 in every zone, starts at its own midnight; the minute before
    // belongs to the day before and is left out.
    await at("2026-10-22T20:59:00Z"); // Istanbul: 23:59 on 10-22, not shown
    await at("2026-10-22T21:00:00Z"); // Istanbul: 00:00 on 10-23, the first day
    await at("2026-10-22T23:59:00Z"); // UTC: 10-22, not shown
    await at("2026-10-23T00:00:00Z"); // UTC: 00:00 on 10-23, the first day
    await at("2026-10-23T06:59:00Z"); // Los Angeles: 23:59 on 10-22, not shown
    await at("2026-10-23T07:00:00Z"); // Los Angeles: 00:00 on 10-23, the first day
    const now = new Date("2026-11-21T09:00:00Z");
    const expected = {
      "Europe/Istanbul": [
        ["2026-11-21", 5],
        ["2026-11-20", 1],
        ["2026-10-23", 5],
      ],
      UTC: [
        ["2026-11-21", 3],
        ["2026-11-20", 3],
        ["2026-10-23", 3],
      ],
      "America/Los_Angeles": [
        ["2026-11-21", 1],
        ["2026-11-20", 5],
        ["2026-10-23", 1],
      ],
    };
    for (const sessionZone of SESSION_ZONES) {
      for (const [zone, want] of Object.entries(expected)) {
        expect(
          await days(ada, zone, sessionZone, now),
          `${zone} in a ${sessionZone} session`,
        ).toEqual(want);
      }
    }
  });

  it("cuts days at the right instant on the days the clocks change", async () => {
    const ada = await person();
    const at = (iso: string) => usage(ada, { createdAt: new Date(iso) });
    // Los Angeles falls back on 2026-11-01 (a 25-hour day) and springs forward on 2026-03-08.
    await at("2026-11-01T06:59:00Z"); // 23:59 PDT on 10-31
    await at("2026-11-01T07:00:00Z"); // 00:00 PDT on 11-01
    await at("2026-11-02T07:59:00Z"); // 23:59 PST on 11-01, 24 hours and 59 minutes later
    await at("2026-11-02T08:00:00Z"); // 00:00 PST on 11-02
    const fall = new Date("2026-11-02T12:00:00Z");
    for (const sessionZone of SESSION_ZONES) {
      expect(await days(ada, "America/Los_Angeles", sessionZone, fall)).toEqual([
        ["2026-11-02", 1],
        ["2026-11-01", 2],
        ["2026-10-31", 1],
      ]);
    }
    const bob = await person();
    const inSpring = (iso: string) => usage(bob, { createdAt: new Date(iso) });
    await inSpring("2026-03-08T07:59:00Z"); // 23:59 PST on 03-07
    await inSpring("2026-03-08T08:00:00Z"); // 00:00 PST on 03-08
    await inSpring("2026-03-09T06:59:00Z"); // 23:59 PST on 03-08 (a 23-hour day: PDT starts at 10:00Z)
    await inSpring("2026-03-09T07:00:00Z"); // 00:00 PDT on 03-09
    const springNow = new Date("2026-03-09T12:00:00Z");
    for (const sessionZone of SESSION_ZONES) {
      expect(await days(bob, "America/Los_Angeles", sessionZone, springNow)).toEqual([
        ["2026-03-09", 1],
        ["2026-03-08", 2],
        ["2026-03-07", 1],
      ]);
    }
  });

  it("reads a zone the database does not know as UTC instead of failing", async () => {
    const ada = await person();
    await usage(ada, { createdAt: new Date("2026-11-20T22:00:00Z") });
    const now = new Date("2026-11-21T09:00:00Z");
    // An offset is a valid zone to JavaScript, but not a name the database lists.
    for (const zone of ["+03:00", "Not/AZone"]) {
      expect(await days(ada, zone, "America/Los_Angeles", now)).toEqual([["2026-11-20", 1]]);
    }
  });

  it("gives an empty period no days", async () => {
    const ada = await person();
    await usage(ada, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const now = new Date("2026-11-21T09:00:00Z");
    expect(await runAsTenant(ada, () => readDayCells(prisma, ada, "UTC", now))).toEqual([]);
  });

  it("reads every member of the Space for the person grouping, and no other Space", async () => {
    const ada = await person();
    const bob = await addMember(ada, "Bob");
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

  it("refuses the person grouping to a member, even one who owns another Space", async () => {
    const ada = await person();
    const bob = await addMember(ada, "Bob");
    // Bob owns a Space of his own, but is only a member of Ada's.
    const bobsOrg = bob.userId;
    await system.organization.create({
      data: { id: `${bobsOrg}-own`, name: "Own", slug: `${bobsOrg}-own`, createdAt: new Date() },
    });
    await system.member.create({
      data: {
        id: `m-${bobsOrg}-own`,
        organizationId: `${bobsOrg}-own`,
        userId: bob.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const ownSpace = randomUUID();
    await system.space.create({
      data: {
        id: ownSpace,
        organizationId: `${bobsOrg}-own`,
        name: "Own",
        createdByUserId: bob.userId,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: ownSpace,
        organizationId: `${bobsOrg}-own`,
        userId: bob.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    orgs.push(`${bobsOrg}-own`);
    await usage(ada, { costUsd: 1 });
    await usage(bob, { costUsd: 2 });
    const ctx = createRouterContext({
      prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
    } as unknown as RouterDeps);
    const as = (actor: Actor) =>
      createRouterClient(dozoUsageRoutes(ctx), { context: { actor } }).dozoUsage;
    const inAda = as(bob);
    // Owner of the other Space, ordinary member of this one: refused here, offered nothing.
    await expect(runAsTenant(bob, () => inAda.breakdown({ by: "person" }))).rejects.toMatchObject({
      name: "SpaceOwnerRequiredError",
    });
    await expect(runAsTenant(bob, () => inAda.csv({ by: "person" }))).rejects.toMatchObject({
      name: "SpaceOwnerRequiredError",
    });
    expect(await runAsTenant(bob, () => inAda.scope())).toEqual({ person: false });
    // In his own Space, where he owns it and is alone, nothing is offered but nothing leaks either.
    const own: Actor = { ...bob, spaceId: ownSpace };
    expect(await runAsTenant(own, () => as(own).scope())).toEqual({ person: false });
    // The owner sees both people.
    expect(await runAsTenant(ada, () => as(ada).scope())).toEqual({ person: true });
    const seen = await runAsTenant(ada, () => as(ada).breakdown({ by: "person" }));
    expect(seen.map((g) => g.costUsd).sort()).toEqual([1, 2]);
  });
});
