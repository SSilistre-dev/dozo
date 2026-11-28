import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { DozoStatsCardSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dozoStatsShareKind, readBotStats } from "./dozo-bot-stats.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("a bot's stats (PostgreSQL)", () => {
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
    const id = `bot-stats-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada Owner", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Secret Space", createdByUserId: id },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { userId: id, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  async function addMember(owner: Actor): Promise<Actor> {
    const id = `bot-stats-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Bo", email: `${id}@example.test`, emailVerified: true },
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

  async function work(
    actor: Actor,
    owner: { id: string; threadId: string },
    more: { status: string; trigger: string; completedAt?: Date; by?: Actor },
  ) {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: (more.by ?? actor).userId,
        botId: owner.id,
        threadId: owner.threadId,
        prompt: "Private prompt text",
        status: more.status,
      },
    });
    await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: (more.by ?? actor).userId,
        botId: owner.id,
        threadId: owner.threadId,
        taskId: task.id,
        status: more.status,
        trigger: more.trigger,
        completedAt: more.completedAt,
      },
    });
  }

  it("counts the owner's own finished work once: a task or a routine run, never helpers or others", async () => {
    const actor = await person();
    const member = await addMember(actor);
    const mine = await bot(actor, "Counter");
    const other = await bot(actor, "Other");
    const noon = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
    const done = (trigger: string, day: number, more: { by?: Actor; status?: string } = {}) =>
      work(actor, mine, {
        status: more.status ?? "completed",
        trigger,
        completedAt: noon(day),
        by: more.by,
      });
    await done("user", 1);
    await done("user", 1);
    await done("routine", 1);
    await done("routine", 3);
    // A helper and the turn that relays its result belong to the same request.
    await done("helper", 4);
    await done("helper_result", 4);
    await done("tickets", 4);
    // Cancelled and failed turns, and another member's turns in the shared Space, are not counted.
    await done("user", 5, { status: "failed" });
    await done("routine", 6, { status: "cancelled" });
    await done("user", 7, { by: member });
    await done("routine", 8, { by: member });
    await work(actor, other, { status: "completed", trigger: "routine", completedAt: noon(9) });
    await system.taughtSkill.createMany({
      data: [
        ["saved", actor],
        ["draft", actor],
        ["saved", member],
      ].map(([status, by]) => ({
        spaceId: actor.spaceId,
        userId: (by as Actor).userId,
        botId: mine.id,
        goal: "Private goal",
        status: status as string,
      })),
    });
    expect(await readBotStats(system, actor, mine.id)).toEqual({
      tasksFinished: 2,
      routineRuns: 2,
      skillsLearned: 1,
      daysActive: 2,
      more: false,
    });
  });

  it("lets only the owner share, and publishes nothing but the name, look and numbers", async () => {
    const owner = await person();
    const member = await addMember(owner);
    const mine = await bot(owner, "Public Name");
    const asOwner = (fn: () => Promise<unknown>) => runAsTenant(owner, fn);
    expect(await asOwner(() => dozoStatsShareKind.canShare(prisma, owner, mine.id))).toBe(true);
    const asMember = await runAsTenant(member, () =>
      dozoStatsShareKind.canShare(prisma, member, mine.id),
    );
    expect(asMember).toBe(false);
    const payload = await dozoStatsShareKind.load(system, {
      userId: owner.userId,
      spaceId: owner.spaceId,
      targetId: mine.id,
    });
    expect(DozoStatsCardSchema.strict().parse(payload).name).toBe("Public Name");
    expect(JSON.stringify(payload)).not.toMatch(/Secret Space|Ada Owner|example\.test|Private/);
  });
});
