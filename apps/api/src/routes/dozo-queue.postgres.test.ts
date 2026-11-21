import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";
import { STOPPED_BY_MESSAGE_NOTE, stoppedRoutineNote } from "../thread-stop.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

type Item = {
  id: string;
  kind: string;
  position: number;
  mine: boolean;
  reason: string;
  waitingFor?: string | null;
  label?: string | null;
};

describePostgres("what waits for a shared bot (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const publishSpaceChange = vi.fn();
  const notify = vi.fn().mockResolvedValue(undefined);
  const users: string[] = [];
  const organizations: string[] = [];

  async function person(name: string): Promise<Actor> {
    const id = `queue-${name}-${randomUUID()}`;
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  /** A Space of the owner's organization that a member joined, with the owner's bot in it. */
  async function sharedSpace() {
    const owner = await person("owner");
    const member = await person("member");
    const spaceId = randomUUID();
    const organizationId = owner.spaceId;
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Home", createdByUserId: owner.userId },
    });
    const createdAt = new Date();
    await system.member.create({
      data: { id: randomUUID(), organizationId, userId: member.userId, role: "member", createdAt },
    });
    for (const [userId, role] of [
      [owner.userId, "owner"],
      [member.userId, "member"],
    ] as const)
      await system.spaceMember.create({
        data: { id: randomUUID(), spaceId, organizationId, userId, role, createdAt },
      });
    const shared = { owner: { ...owner, spaceId }, member: { ...member, spaceId } };
    const bot = await runAsTenant(shared.owner, () =>
      createRepos(prisma).createBot(shared.owner, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    return { ...shared, botId: bot.id, threadId: thread.id, spaceId };
  }

  let clock = 0;
  async function newRun(
    space: { spaceId: string; botId: string; threadId: string },
    userId: string,
    patch: { status?: string; trigger?: string; routineId?: string; sourceMessageId?: string } = {},
  ) {
    clock += 1;
    const task = await system.task.create({
      data: {
        spaceId: space.spaceId,
        botId: space.botId,
        threadId: space.threadId,
        userId,
        prompt: "private prompt text",
        status: "queued",
      },
    });
    return system.run.create({
      data: {
        spaceId: space.spaceId,
        botId: space.botId,
        threadId: space.threadId,
        taskId: task.id,
        userId,
        status: patch.status ?? "queued",
        trigger: patch.trigger ?? "user",
        routineId: patch.routineId,
        sourceMessageId: patch.sourceMessageId,
        createdAt: new Date(Date.now() - 60_000 + clock * 1000),
      },
    });
  }

  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };
  const newMessage = (threadId: string, userId: string, text: string, runId: string | null) =>
    system.message.create({
      data: {
        threadId,
        seq: nextSeq(),
        role: "user",
        blocks: [{ kind: "text", text }],
        authorUserId: userId,
        runId,
      },
    });

  async function call(actor: Actor, path: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: unknown };
    return { status: response!.status, json: body.json };
  }

  const list = async (actor: Actor, botId: string) => {
    const answer = await call(actor, "dozoQueue/list", { botId });
    expect(answer.status).toBe(200);
    return (answer.json as { items: Item[] }).items;
  };

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const deps = {
      prisma,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://app.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      events: { notify, publishSpaceChange },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      artifacts: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-queue-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("lists each person's wait in the bot's order, with words only for their own work", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    const routine = await system.routine.create({
      data: {
        botId: space.botId,
        spaceId: space.spaceId,
        userId: owner.userId,
        name: "Weekly sums",
        prompt: "Add things up",
        crons: [],
      },
    });
    const working = await newRun(space, owner.userId, {
      status: "running",
      trigger: "routine",
      routineId: routine.id,
    });
    const ask = await newMessage(space.threadId, member.userId, "Plan my week", null);
    const mine = await newRun(space, member.userId, { sourceMessageId: ask.id });
    const theirsAsk = await newMessage(space.threadId, owner.userId, "Owner secret words", null);
    const theirs = await newRun(space, owner.userId, { sourceMessageId: theirsAsk.id });
    const heldAsk = await newMessage(space.threadId, member.userId, "A later thought", working.id);
    await system.steeringMessage.create({
      data: { messageId: heldAsk.id, botId: space.botId, userId: member.userId, runId: null },
    });

    const asMember = await list(member, space.botId);
    expect(
      asMember.map((item) => [item.id, item.kind, item.position, item.mine, item.reason]),
    ).toEqual([
      [mine.id, "run", 1, true, "bot_busy"],
      [theirs.id, "run", 2, false, "bot_busy"],
      [heldAsk.id, "message", 3, true, "behind_run"],
    ]);
    expect(asMember.map((item) => item.label)).toEqual(["Plan my week", null, "A later thought"]);
    // The routine is the owner's: the member is not told its name.
    expect(asMember.map((item) => item.waitingFor ?? null)).toEqual([null, null, null]);
    expect(JSON.stringify(asMember)).not.toContain("Owner secret words");
    expect(JSON.stringify(asMember)).not.toContain("Weekly sums");
    expect(JSON.stringify(asMember)).not.toContain("private prompt text");

    const asOwner = await list(owner, space.botId);
    expect(asOwner.map((item) => [item.id, item.position, item.mine])).toEqual([
      [mine.id, 1, false],
      [theirs.id, 2, true],
      [heldAsk.id, 3, false],
    ]);
    expect(asOwner.map((item) => item.label)).toEqual([null, "Owner secret words", null]);
    expect(asOwner.map((item) => item.waitingFor ?? null)).toEqual([
      "Weekly sums",
      "Weekly sums",
      "Weekly sums",
    ]);
    expect(JSON.stringify(asOwner)).not.toContain("Plan my week");
  });

  it("holds a run for a bot sharing the computer, and shows nothing for a backoff", async () => {
    const space = await sharedSpace();
    const { owner } = space;
    const other = await runAsTenant(owner, () =>
      createRepos(prisma).createBot(owner, {
        name: "Scout",
        description: "",
        instructions: "Scout.",
        notifyOnFinish: false,
      }),
    );
    const mine = await system.bot.findUniqueOrThrow({
      where: { id: space.botId },
      select: { computerId: true },
    });
    const otherRow = await system.bot.findUniqueOrThrow({
      where: { id: other.id },
      select: { computerId: true },
    });
    // Both bots use the team computer; a lease of the other bot's run holds it.
    expect(otherRow.computerId).toBe(mine.computerId);
    const holder = await newRun(
      { ...space, botId: other.id, threadId: space.threadId },
      owner.userId,
      {
        status: "running",
      },
    );
    const waiting = await newRun(space, owner.userId);
    const later = new Date(Date.now() + 60_000);
    await system.run.update({ where: { id: waiting.id }, data: { wakeAt: later } });
    expect(await list(owner, space.botId)).toEqual([]);
    await system.computerExecutionLease.create({
      data: {
        computerId: mine.computerId!,
        botId: other.id,
        runId: holder.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await list(owner, space.botId)).toEqual([
      expect.objectContaining({ id: waiting.id, reason: "computer_busy", position: 1, mine: true }),
    ]);
    await system.run.update({ where: { id: holder.id }, data: { status: "completed" } });
    expect(await list(owner, space.botId)).toEqual([]);
  });

  it("answers no one outside the Space, and no one who cannot reach the bot", async () => {
    const space = await sharedSpace();
    const stranger = await person("stranger");
    expect((await call(stranger, "dozoQueue/list", { botId: space.botId })).status).toBe(404);
    expect((await call(stranger, "dozoQueue/cancelWaiting", { runId: "no-such-run" })).status).toBe(
      404,
    );
  });

  it("cancels only the caller's own queued run", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    const working = await newRun(space, owner.userId, { status: "running" });
    const mine = await newRun(space, member.userId);
    const theirs = await newRun(space, owner.userId);
    const statusOf = async (id: string) =>
      (await system.run.findUniqueOrThrow({ where: { id } })).status;
    publishSpaceChange.mockClear();

    // Not theirs, not queued: nothing changes and nothing is signalled.
    expect((await call(member, "dozoQueue/cancelWaiting", { runId: theirs.id })).status).toBe(404);
    expect((await call(member, "dozoQueue/cancelWaiting", { runId: working.id })).status).toBe(404);
    expect((await call(owner, "dozoQueue/cancelWaiting", { runId: mine.id })).status).toBe(404);
    expect([
      await statusOf(working.id),
      await statusOf(mine.id),
      await statusOf(theirs.id),
    ]).toEqual(["running", "queued", "queued"]);
    expect(publishSpaceChange).not.toHaveBeenCalled();

    expect((await call(member, "dozoQueue/cancelWaiting", { runId: mine.id })).status).toBe(200);
    expect([
      await statusOf(working.id),
      await statusOf(mine.id),
      await statusOf(theirs.id),
    ]).toEqual(["running", "cancelled", "queued"]);
    expect(publishSpaceChange).toHaveBeenCalledWith(space.spaceId, "runs");
    expect((await list(member, space.botId)).map((item) => item.id)).toEqual([theirs.id]);
    // A second try finds nothing waiting.
    expect((await call(member, "dozoQueue/cancelWaiting", { runId: mine.id })).status).toBe(404);
  });

  it("cancels only the caller's own held message", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    const working = await newRun(space, owner.userId, { status: "running", trigger: "routine" });
    const message = await newMessage(space.threadId, member.userId, "Hold this", working.id);
    await system.steeringMessage.create({
      data: { messageId: message.id, botId: space.botId, userId: member.userId, runId: null },
    });
    const held = () => system.steeringMessage.count({ where: { messageId: message.id } });
    publishSpaceChange.mockClear();

    expect((await call(owner, "dozoQueue/cancelWaiting", { messageId: message.id })).status).toBe(
      404,
    );
    expect(await held()).toBe(1);
    expect(publishSpaceChange).not.toHaveBeenCalled();

    expect((await call(member, "dozoQueue/cancelWaiting", { messageId: message.id })).status).toBe(
      200,
    );
    expect(await held()).toBe(0);
    expect(publishSpaceChange).toHaveBeenCalledWith(space.spaceId, "runs");
    expect(await list(member, space.botId)).toEqual([]);
    // The message stays in the chat, and the run it waited behind is untouched.
    expect(await system.message.count({ where: { id: message.id } })).toBe(1);
    expect((await system.run.findUniqueOrThrow({ where: { id: working.id } })).status).toBe(
      "running",
    );
  });

  it("does not let a held message of the caller's be cancelled after it is claimed", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    const working = await newRun(space, owner.userId, { status: "running" });
    const message = await newMessage(space.threadId, member.userId, "Taken", working.id);
    await system.steeringMessage.create({
      data: {
        messageId: message.id,
        botId: space.botId,
        userId: member.userId,
        runId: working.id,
        claimedAt: new Date(),
      },
    });
    expect((await call(member, "dozoQueue/cancelWaiting", { messageId: message.id })).status).toBe(
      404,
    );
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(1);
  });

  /** The chat's system notes, oldest first, as the chat reads them. */
  const notes = async (threadId: string) =>
    (
      await system.message.findMany({
        where: { threadId, role: "system" },
        orderBy: { seq: "asc" },
      })
    )
      .flatMap((message) => message.blocks as Array<{ kind: string; text: string }>)
      .map((block) => block.text);
  const noteEvents = (threadId: string) =>
    system.event.findMany({ where: { threadId, type: "thread.message.created" } });

  it("says a cancelled held message stopped, as Stop does, and the message joins history", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    const working = await newRun(space, owner.userId, { status: "running" });
    const message = await newMessage(space.threadId, member.userId, "Hold this", working.id);
    await system.steeringMessage.create({
      data: { messageId: message.id, botId: space.botId, userId: member.userId, runId: null },
    });
    notify.mockClear();

    expect((await call(member, "dozoQueue/cancelWaiting", { messageId: message.id })).status).toBe(
      200,
    );
    expect(await notes(space.threadId)).toEqual([STOPPED_BY_MESSAGE_NOTE]);
    const [event] = await noteEvents(space.threadId);
    expect(event?.botId).toBe(space.botId);
    // Other clients are told to catch up to that event.
    expect(notify).toHaveBeenCalledWith(space.threadId, event?.seq);
    // The next turn's history leaves out a message only while steering holds it (the filter in
    // run-assembly-history); Stop deletes the hold, and so does this: the message is history.
    const stored = await system.message.findUniqueOrThrow({
      where: { id: message.id },
      include: { steeringMessages: true },
    });
    expect(stored.steeringMessages).toHaveLength(0);
    // Nothing is said for a try that finds nothing to cancel.
    expect((await call(member, "dozoQueue/cancelWaiting", { messageId: message.id })).status).toBe(
      404,
    );
    expect(await notes(space.threadId)).toEqual([STOPPED_BY_MESSAGE_NOTE]);
  });

  it("says so when a queued run goes with the follow-ups sent to it", async () => {
    const space = await sharedSpace();
    const { owner, member } = space;
    await newRun(space, owner.userId, { status: "running" });
    const mine = await newRun(space, member.userId);
    const followUp = await newMessage(space.threadId, member.userId, "And this", mine.id);
    await system.steeringMessage.create({
      data: { messageId: followUp.id, botId: space.botId, userId: member.userId, runId: mine.id },
    });

    expect((await call(member, "dozoQueue/cancelWaiting", { runId: mine.id })).status).toBe(200);
    expect(await system.steeringMessage.count({ where: { messageId: followUp.id } })).toBe(0);
    expect(await notes(space.threadId)).toEqual([STOPPED_BY_MESSAGE_NOTE]);
    expect(await noteEvents(space.threadId)).toHaveLength(1);
  });

  it("names the routine for a cancelled routine run and leaves its schedule alone", async () => {
    const space = await sharedSpace();
    const { owner } = space;
    const routine = await system.routine.create({
      data: {
        botId: space.botId,
        spaceId: space.spaceId,
        userId: owner.userId,
        threadId: space.threadId,
        name: "Weekly sums",
        prompt: "Add things up",
        crons: ["0 9 * * 1"],
        active: true,
        lastRunAt: new Date("2026-11-16T09:00:00Z"),
        nextRunAt: new Date("2026-11-23T09:00:00Z"),
      },
    });
    await newRun(space, owner.userId, { status: "running" });
    const queued = await newRun(space, owner.userId, {
      trigger: "routine",
      routineId: routine.id,
    });
    const before = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    const runsBefore = await system.run.count({ where: { routineId: routine.id } });

    expect((await call(owner, "dozoQueue/cancelWaiting", { runId: queued.id })).status).toBe(200);
    expect(await notes(space.threadId)).toEqual([stoppedRoutineNote("Weekly sums")]);
    // The next firing is the routine's own business: the row is exactly as it was.
    expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toEqual(before);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(runsBefore);
  });
});
