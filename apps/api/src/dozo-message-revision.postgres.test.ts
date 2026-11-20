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
  readMessageBlocks,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("editing the last message and regenerating the last reply (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const enqueue = vi.fn();
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `revision-${randomUUID()}`;
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

  const messagesOf = (threadId: string) =>
    system.message.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
  const eventsAbout = (threadId: string, messageId: string) =>
    system.event.findMany({
      where: { threadId, payload: { path: ["messageId"], equals: messageId } },
      orderBy: { seq: "asc" },
    });

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
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-revision-test",
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

  it("regenerates: the old reply leaves the chat and its events, and the next reply takes its seq", async () => {
    const me = await person();
    const turn = await chat(me);
    expect((await call(me, "dozoMessages/revisable", { threadId: turn.threadId })).json).toEqual({
      editMessageId: turn.askId,
      regenerateMessageId: turn.reply.id,
    });

    const regenerated = await call(me, "dozoMessages/regenerate", {
      threadId: turn.threadId,
      messageId: turn.reply.id,
    });
    expect(regenerated.status).toBe(200);
    const runId = regenerated.json.runId as string;

    expect((await messagesOf(turn.threadId)).map((m) => m.id)).toEqual([turn.askId]);
    expect((await eventsAbout(turn.threadId, turn.reply.id)).map((e) => e.payload)).toEqual([
      { messageId: turn.reply.id, removed: true },
    ]);
    // The message's own event stays: only the edit replaces it.
    expect((await eventsAbout(turn.threadId, turn.askId)).map((e) => e.type)).toEqual([
      "thread.message.created",
    ]);
    const run = await system.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "queued", trigger: "user", sourceMessageId: turn.askId });
    expect((await system.message.findUniqueOrThrow({ where: { id: turn.askId } })).runId).toBe(
      runId,
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));

    // The thread is busy until the new run ends.
    expect((await call(me, "dozoMessages/revisable", { threadId: turn.threadId })).json).toEqual({
      editMessageId: null,
      regenerateMessageId: null,
    });
    await system.run.update({ where: { id: runId }, data: { status: "running" } });
    const next = await botSays(me, { threadId: turn.threadId, botId: turn.botId, runId }, "Soup.");
    expect(next.seq).toBe(turn.reply.seq);
  });

  it("edits: the message holds the new text, its old event is replaced, and the run starts on it", async () => {
    const me = await person();
    const turn = await chat(me);
    const edited = await call(me, "dozoMessages/edit", {
      threadId: turn.threadId,
      messageId: turn.askId,
      text: "Plan lunch",
    });
    expect(edited.status).toBe(200);

    const [ask, ...rest] = await messagesOf(turn.threadId);
    expect(rest).toEqual([]);
    expect(readMessageBlocks(ask!).blocks).toEqual([{ kind: "text", text: "Plan lunch" }]);
    const events = await eventsAbout(turn.threadId, turn.askId);
    expect(events.map((e) => [e.type, (e.payload as { blocks?: unknown }).blocks])).toEqual([
      ["thread.message.updated", [{ kind: "text", text: "Plan lunch" }]],
    ]);
    const task = await system.task.findFirstOrThrow({
      where: { runs: { some: { id: edited.json.runId as string } } },
    });
    expect(task.prompt).toBe("Plan lunch");
  });

  it("refuses once the reply called a tool, and changes nothing", async () => {
    const me = await person();
    const turn = await chat(me);
    await system.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId: me.spaceId,
        threadId: turn.threadId,
        botId: turn.botId,
        type: "agent.tool.called",
        runId: turn.runId,
        payload: { name: "send_email" },
      }),
    );
    expect((await call(me, "dozoMessages/revisable", { threadId: turn.threadId })).json).toEqual({
      editMessageId: null,
      regenerateMessageId: null,
    });
    const refused = await call(me, "dozoMessages/regenerate", {
      threadId: turn.threadId,
      messageId: turn.reply.id,
    });
    expect(refused.status).toBe(409);
    expect((await messagesOf(turn.threadId)).map((m) => m.id)).toEqual([turn.askId, turn.reply.id]);
  });

  it("hides another person's chat", async () => {
    const me = await person();
    const turn = await chat(me);
    const stranger = await person();
    const read = await call(stranger, "dozoMessages/revisable", { threadId: turn.threadId });
    expect(read.status).toBe(404);
  });
});
