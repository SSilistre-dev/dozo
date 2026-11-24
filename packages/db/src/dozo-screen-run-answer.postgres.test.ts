import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createThreadMessage } from "./messages.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { answerRunInput } from "./thread-ask.js";

// Allow for this run on a card for input on the bot's screen (dozo/brand/brand.json,
// packages/db/src/thread-ask.ts; the gate is packages/adapters/src/dozo-screen-run.ts). Runs on the
// branded tree only, against a migrated database; the fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("Allow for this run (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];

  async function user(name: string) {
    const id = `screen-run-${randomUUID()}`;
    users.push(id);
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    return id;
  }

  /** A member's run of their bot waiting on the card for typing on the bot's screen. */
  async function screenCard() {
    const userId = await user("Ada");
    const createdAt = new Date();
    await system.organization.create({
      data: { id: userId, name: "Team", slug: userId, createdAt },
    });
    await system.member.create({
      data: { id: `m-${userId}`, organizationId: userId, userId, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: userId, name: "Home", createdByUserId: userId },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: userId, userId, role: "owner", createdAt },
    });
    const otherId = await user("Grace");
    await system.member.create({
      data: {
        id: `m-${otherId}`,
        organizationId: userId,
        userId: otherId,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: userId,
        userId: otherId,
        role: "member",
        createdAt,
      },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await system.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Fill in the form",
        status: "waiting_input",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    await system.attempt.create({ data: { runId: run.id, fence: 1, status: "waiting_input" } });
    const effect = await system.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "computer_act",
        idempotencyKey: randomUUID(),
        status: "intended",
        request: { actions: [{ kind: "type", text: "Ada" }] },
      },
    });
    const message = await createThreadMessage(system, {
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          approvalEffectId: effect.id,
          text: "Review before computer_act",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "allow_run", label: "Allow for this run" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    const answer = (by: string) =>
      runAsTenant({ userId: by, spaceId }, () =>
        answerRunInput(prisma, {
          spaceId,
          threadId: thread.id,
          runId: run.id,
          messageId: message.id,
          answeredByUserId: by,
          answer: "allow_run",
        }),
      );
    const effectStatus = async () =>
      (await system.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status;
    const rules = async () =>
      (await system.actionApprovalRule.count({ where: { spaceId } })) +
      (await system.userActionApprovalRule.count({ where: { userId } }));
    return { userId, otherId, answer, effectStatus, rules };
  }

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

  it("allows the call on the card, saves no lasting rule, and records the answer", async () => {
    const card = await screenCard();
    expect(await card.answer(card.userId)).toBe(true);
    expect(await card.effectStatus()).toBe("approved");
    expect(await card.rules()).toBe(0);
  });

  it("refuses another member's answer, and the card still waits for the run's own member", async () => {
    const card = await screenCard();
    expect(await card.answer(card.otherId)).toBeFalsy();
    expect(await card.effectStatus()).toBe("intended");
    expect(await card.answer(card.userId)).toBe(true);
  });

  it("takes one answer when the card is answered twice", async () => {
    const card = await screenCard();
    const answers = await Promise.allSettled([card.answer(card.userId), card.answer(card.userId)]);
    expect(answers.filter((answer) => answer.status === "fulfilled" && answer.value)).toHaveLength(
      1,
    );
    expect(await card.answer(card.userId)).toBeFalsy();
  });
});
