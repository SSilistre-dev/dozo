import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  createThreadMessageInTransaction,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("pinned messages (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const enqueue = vi.fn();
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `pins-${randomUUID()}`;
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

  /** A finished turn: the person's message and the bot's one reply, as a send and a run leave them. */
  async function chat(actor: Actor) {
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
    const threadId = (await system.thread.findFirstOrThrow({ where: { botId: bot.id } })).id;
    const sent = await createThreadEvents(system).sendUserMessage({
      spaceId: actor.spaceId,
      threadId,
      botId: bot.id,
      userId: actor.userId,
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Plan dinner" }],
      prompt: "Plan dinner",
      trigger: "user",
      clientNonce: randomUUID(),
      linkMessageToRun: true,
    });
    const runId = sent.runId!;
    await system.run.update({ where: { id: runId }, data: { status: "running" } });
    const reply = await botSays(actor, { threadId, botId: bot.id, runId }, "Pasta.");
    await system.run.update({ where: { id: runId }, data: { status: "completed" } });
    return { botId: bot.id, threadId, askId: sent.messageId, askSeq: sent.seq, runId, reply };
  }

  function botSays(
    actor: Actor,
    at: { threadId: string; botId: string; runId: string },
    text: string,
  ) {
    return system.$transaction(async (tx) => {
      const blocks = [{ kind: "text" as const, text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: at.threadId,
        role: "bot",
        botId: at.botId,
        runId: at.runId,
        blocks,
      });
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: at.threadId,
        botId: at.botId,
        type: "thread.message.created",
        runId: at.runId,
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return message;
    });
  }

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: unknown };
    return { status: response!.status, json: body.json as Record<string, unknown> };
  }

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
      events: createThreadEvents(prisma),
      jobs: { enqueue },
      // No Space memory learns from turns, so a revision can take one back.
      memoryProviders: { resolve: async () => null },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-pins-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const pinsOf = async (actor: Actor, threadId: string) =>
    (
      (await call(actor, "dozoMessages/pins", { threadId })).json.pins as { messageId: string }[]
    ).map((pin) => pin.messageId);
  const pin = (actor: Actor, threadId: string, messageId: string, pinned = true) =>
    call(actor, "dozoMessages/pin", { threadId, messageId, pinned });
  const pinRows = (threadId: string) =>
    system.$queryRaw<{ userId: string; messageId: string }[]>`
      SELECT "userId", "messageId" FROM dozo_message_pins WHERE "threadId" = ${threadId}`;

  it("pins and unpins a message, newest first, and doing it twice changes nothing", async () => {
    const me = await person();
    const turn = await chat(me);
    expect(await pinsOf(me, turn.threadId)).toEqual([]);
    expect((await pin(me, turn.threadId, turn.askId)).json).toEqual({ pinned: true });
    expect((await pin(me, turn.threadId, turn.reply.id)).status).toBe(200);
    expect((await pin(me, turn.threadId, turn.reply.id)).status).toBe(200);
    expect(await pinsOf(me, turn.threadId)).toEqual([turn.reply.id, turn.askId]);
    const listed = await call(me, "dozoMessages/pins", { threadId: turn.threadId });
    expect(listed.json.pins).toContainEqual({
      messageId: turn.reply.id,
      preview: { role: "bot", botId: turn.botId, text: "Pasta." },
    });
    expect((await pin(me, turn.threadId, turn.askId, false)).json).toEqual({ pinned: false });
    expect((await pin(me, turn.threadId, turn.askId, false)).status).toBe(200);
    expect(await pinsOf(me, turn.threadId)).toEqual([turn.reply.id]);
  });

  it("drops the pin of a regenerated reply with the reply, and keeps an edited message's", async () => {
    const me = await person();
    const turn = await chat(me);
    await pin(me, turn.threadId, turn.askId);
    await pin(me, turn.threadId, turn.reply.id);
    const regenerated = await call(me, "dozoMessages/regenerate", {
      threadId: turn.threadId,
      messageId: turn.reply.id,
    });
    expect(regenerated.status).toBe(200);
    expect(await pinsOf(me, turn.threadId)).toEqual([turn.askId]);
    expect((await pinRows(turn.threadId)).map((row) => row.messageId)).toEqual([turn.askId]);
  });

  it("keeps a person's pins from every other member, and drops them when they leave", async () => {
    const me = await person();
    const turn = await chat(me);
    await pin(me, turn.threadId, turn.reply.id);
    const other = await person();
    await system.member.create({
      data: {
        id: `m-${other.userId}-joined`,
        organizationId: me.userId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: me.spaceId,
        organizationId: me.userId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const seenByOther = await runAsTenant(
      { spaceId: me.spaceId, userId: other.userId },
      () =>
        prisma.$queryRaw<
          unknown[]
        >`SELECT 1 FROM dozo_message_pins WHERE "threadId" = ${turn.threadId}`,
    );
    expect(seenByOther).toEqual([]);
    expect(await pinRows(turn.threadId)).toEqual([{ userId: me.userId, messageId: turn.reply.id }]);
    await system.spaceMember.deleteMany({ where: { spaceId: me.spaceId, userId: me.userId } });
    expect(await pinRows(turn.threadId)).toEqual([]);
  });

  it("hides another person's chat and refuses a message from another chat", async () => {
    const me = await person();
    const turn = await chat(me);
    const stranger = await person();
    expect((await call(stranger, "dozoMessages/pins", { threadId: turn.threadId })).status).toBe(
      404,
    );
    expect((await pin(stranger, turn.threadId, turn.reply.id)).status).toBe(404);
    const theirs = await chat(stranger);
    expect((await pin(me, turn.threadId, theirs.reply.id)).status).toBe(404);
    expect(await pinRows(theirs.threadId)).toEqual([]);
  });
});
