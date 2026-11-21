import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, MessageBlock } from "@rakazo/contracts";
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

describePostgres("editing a message and regenerating a reply (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const enqueue = vi.fn();
  let memoryLearns = false;
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
    return { botId: bot.id, ...(await turn(actor, { threadId, botId: bot.id }, "Plan dinner")) };
  }

  async function turn(
    actor: Actor,
    at: { threadId: string; botId: string },
    text: string,
    attachment?: MessageBlock,
  ) {
    const sent = await send(actor, at, text, attachment);
    const runId = sent.runId!;
    await system.run.update({ where: { id: runId }, data: { status: "running" } });
    const reply = await botSays(actor, { ...at, runId }, `${text}: done.`);
    await system.run.update({ where: { id: runId }, data: { status: "completed" } });
    return { threadId: at.threadId, askId: sent.messageId, askSeq: sent.seq, runId, reply };
  }

  function send(
    actor: Actor,
    at: { threadId: string; botId: string },
    text: string,
    attachment?: MessageBlock,
  ) {
    return createThreadEvents(system).sendUserMessage({
      spaceId: actor.spaceId,
      threadId: at.threadId,
      botId: at.botId,
      userId: actor.userId,
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text }, ...(attachment ? [attachment] : [])],
      prompt: text,
      trigger: "user",
      clientNonce: randomUUID(),
      linkMessageToRun: true,
    });
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
      // The Space's memory learns from each turn only where a test says so.
      memoryProviders: {
        resolve: vi.fn(async () =>
          memoryLearns ? { provider: { retainConversation: vi.fn() } } : null,
        ),
      },
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

    // The new reply can be regenerated again, and the message edited after it.
    await system.run.update({ where: { id: runId }, data: { status: "completed" } });
    expect((await call(me, "dozoMessages/revisable", { threadId: turn.threadId })).json).toEqual({
      editMessageId: turn.askId,
      regenerateMessageId: next.id,
    });
    const again = await call(me, "dozoMessages/regenerate", {
      threadId: turn.threadId,
      messageId: next.id,
    });
    expect(again.status).toBe(200);
    expect((await messagesOf(turn.threadId)).map((m) => m.id)).toEqual([turn.askId]);
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

  /** Two finished turns, the earlier one pinned and the whole chat read. */
  async function twoTurns(me: Actor) {
    const first = await chat(me);
    const at = { threadId: first.threadId, botId: first.botId };
    const second = await turn(me, at, "Make it vegan");
    for (const messageId of [first.reply.id, second.reply.id])
      expect(
        (await call(me, "dozoMessages/pin", { threadId: at.threadId, messageId, pinned: true }))
          .status,
      ).toBe(200);
    await system.threadRead.upsert({
      where: { threadId_userId: { threadId: first.threadId, userId: me.userId } },
      create: {
        threadId: first.threadId,
        userId: me.userId,
        spaceId: me.spaceId,
        lastReadSeq: second.reply.seq,
      },
      update: { lastReadSeq: second.reply.seq },
    });
    return { first, second, at };
  }

  it("edits an earlier message: every later message, its events and pins go, and the run starts there", async () => {
    const me = await person();
    const { first, second } = await twoTurns(me);
    const read = await call(me, "dozoMessages/revisable", { threadId: first.threadId });
    expect(read.json).toEqual({
      editMessageId: second.askId,
      regenerateMessageId: second.reply.id,
      earlierEditMessageIds: [first.askId],
      earlierRegenerateMessageIds: [first.reply.id],
      removedCounts: { [first.askId]: 3, [first.reply.id]: 3 },
    });

    const edited = await call(me, "dozoMessages/edit", {
      threadId: first.threadId,
      messageId: first.askId,
      text: "Plan lunch",
    });
    expect(edited.status).toBe(200);
    const [ask, ...rest] = await messagesOf(first.threadId);
    expect(rest).toEqual([]);
    expect(readMessageBlocks(ask!).blocks).toEqual([{ kind: "text", text: "Plan lunch" }]);
    for (const removed of [first.reply.id, second.askId, second.reply.id])
      expect((await eventsAbout(first.threadId, removed)).map((e) => e.payload)).toEqual([
        { messageId: removed, removed: true },
      ]);
    // Both pins were on removed replies: they went with them.
    expect((await call(me, "dozoMessages/pins", { threadId: first.threadId })).json).toEqual({
      pins: [],
    });
    const state = await system.threadRead.findUniqueOrThrow({
      where: { threadId_userId: { threadId: first.threadId, userId: me.userId } },
    });
    expect(state.lastReadSeq).toBe(first.askSeq);
    const run = await system.run.findUniqueOrThrow({ where: { id: edited.json.runId as string } });
    expect(run).toMatchObject({ status: "queued", sourceMessageId: first.askId });
    // The old runs stay for usage; the later one no longer points at a message.
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: second.runId } })).sourceMessageId,
    ).toBeNull();

    await system.run.update({ where: { id: run.id }, data: { status: "running" } });
    const next = await botSays(me, { ...first, runId: run.id }, "Salad.");
    expect(next.seq).toBe(first.reply.seq);
  });

  it("regenerates an earlier reply from the message it answered", async () => {
    const me = await person();
    const { first } = await twoTurns(me);
    const regenerated = await call(me, "dozoMessages/regenerate", {
      threadId: first.threadId,
      messageId: first.reply.id,
    });
    expect(regenerated.status).toBe(200);
    expect((await messagesOf(first.threadId)).map((m) => m.id)).toEqual([first.askId]);
    const task = await system.task.findFirstOrThrow({
      where: { runs: { some: { id: regenerated.json.runId as string } } },
    });
    expect(task.prompt).toBe("Plan dinner");
  });

  it.each([["memory.revised"], ["routine.created"], ["agent.tool.called"]])(
    "refuses to go back over a later turn that recorded %s, and changes nothing",
    async (type) => {
      const me = await person();
      const { first, second, at } = await twoTurns(me);
      await system.$transaction((tx) =>
        appendEventInTransaction(tx, {
          spaceId: me.spaceId,
          ...at,
          type,
          runId: second.runId,
          payload: { path: "notes.md" },
        }),
      );
      expect((await call(me, "dozoMessages/revisable", { threadId: first.threadId })).json).toEqual(
        {
          editMessageId: null,
          regenerateMessageId: null,
        },
      );
      const refused = await call(me, "dozoMessages/edit", {
        threadId: first.threadId,
        messageId: first.askId,
        text: "Plan lunch",
      });
      expect(refused.status).toBe(409);
      expect((await messagesOf(first.threadId)).map((m) => m.id)).toEqual([
        first.askId,
        first.reply.id,
        second.askId,
        second.reply.id,
      ]);
    },
  );

  it("lets one of two clients go back and refuses the other", async () => {
    const me = await person();
    const { first } = await twoTurns(me);
    const both = await Promise.all([
      call(me, "dozoMessages/edit", {
        threadId: first.threadId,
        messageId: first.askId,
        text: "Plan lunch",
      }),
      call(me, "dozoMessages/regenerate", { threadId: first.threadId, messageId: first.reply.id }),
    ]);
    expect(both.map((each) => each.status).sort()).toEqual([200, 409]);
    expect((await messagesOf(first.threadId)).map((m) => m.id)).toEqual([first.askId]);
    expect(await system.run.count({ where: { threadId: first.threadId, status: "queued" } })).toBe(
      1,
    );
  });

  it("refuses once a new message arrived after the menu was read", async () => {
    const me = await person();
    const { first, at } = await twoTurns(me);
    const read = await call(me, "dozoMessages/revisable", { threadId: first.threadId });
    expect(read.json.earlierEditMessageIds).toEqual([first.askId]);
    const arrived = await send(me, at, "And dessert");
    const refused = await call(me, "dozoMessages/edit", {
      threadId: first.threadId,
      messageId: first.askId,
      text: "Plan lunch",
    });
    expect(refused.status).toBe(409);
    expect((await messagesOf(first.threadId)).at(-1)?.id).toBe(arrived.messageId);
  });

  const NOTHING = { editMessageId: null, regenerateMessageId: null };
  const revisableIn = async (actor: Actor, threadId: string) =>
    (await call(actor, "dozoMessages/revisable", { threadId })).json;
  const idsIn = async (threadId: string) => (await messagesOf(threadId)).map((m) => m.id);

  it("counts the chat's rewinds, which a summary begun before one compares", async () => {
    const me = await person();
    const { first } = await twoTurns(me);
    const before = await system.thread.findUniqueOrThrow({ where: { id: first.threadId } });
    expect(
      (
        await call(me, "dozoMessages/regenerate", {
          threadId: first.threadId,
          messageId: first.reply.id,
        })
      ).status,
    ).toBe(200);
    const after = await system.thread.findUniqueOrThrow({ where: { id: first.threadId } });
    expect(after.dozoRewinds).toBe(before.dozoRewinds + 1);
    expect(after.nextMessageSeq).toBe(first.reply.seq);
  });

  it("offers nothing and changes nothing while the Space's memory learns from each turn", async () => {
    const me = await person();
    const { first, second } = await twoTurns(me);
    memoryLearns = true;
    try {
      expect(await revisableIn(me, first.threadId)).toEqual(NOTHING);
      const refused = await call(me, "dozoMessages/edit", {
        threadId: first.threadId,
        messageId: second.askId,
        text: "Plan lunch",
      });
      expect(refused.status).toBe(409);
    } finally {
      memoryLearns = false;
    }
    expect(await idsIn(first.threadId)).toEqual([
      first.askId,
      first.reply.id,
      second.askId,
      second.reply.id,
    ]);
  });

  it("does not go back past a later message with a file, which regenerating keeps", async () => {
    const me = await person();
    const first = await chat(me);
    const at = { threadId: first.threadId, botId: first.botId };
    const file: MessageBlock = {
      kind: "file",
      artifactId: randomUUID(),
      mimeType: "application/pdf",
      name: "menu.pdf",
    } as MessageBlock;
    const second = await turn(me, at, "Read this", file);
    expect(await revisableIn(me, first.threadId)).toEqual({
      editMessageId: null,
      regenerateMessageId: second.reply.id,
    });
    expect(
      (await call(me, "dozoMessages/edit", { ...at, messageId: first.askId, text: "x" })).status,
    ).toBe(409);
    expect(await idsIn(first.threadId)).toEqual([
      first.askId,
      first.reply.id,
      second.askId,
      second.reply.id,
    ]);
  });

  it("does not go back past another member's pin, and leaves it in place", async () => {
    const me = await person();
    const { first, second } = await twoTurns(me);
    const other = `revision-${randomUUID()}`;
    users.push(other);
    const createdAt = new Date();
    const space = await system.space.findUniqueOrThrow({ where: { id: me.spaceId } });
    await system.user.create({
      data: { id: other, name: "Bo", email: `${other}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: {
        id: `m-${other}`,
        organizationId: space.organizationId,
        userId: other,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: me.spaceId,
        organizationId: space.organizationId,
        userId: other,
        role: "member",
        createdAt,
      },
    });
    await system.$executeRaw`
      INSERT INTO dozo_message_pins ("userId", "spaceId", "threadId", "messageId")
      VALUES (${other}, ${me.spaceId}, ${first.threadId}, ${second.askId})`;
    expect((await revisableIn(me, first.threadId)).earlierEditMessageIds).toBeUndefined();
    expect(
      (
        await call(me, "dozoMessages/edit", {
          threadId: first.threadId,
          messageId: first.askId,
          text: "Plan lunch",
        })
      ).status,
    ).toBe(409);
    const pins = await system.$queryRaw<Array<{ messageId: string }>>`
      SELECT "messageId" FROM dozo_message_pins WHERE "userId" = ${other}`;
    expect(pins).toEqual([{ messageId: second.askId }]);
  });

  it("treats a later run's event type it does not know as acting outside the chat", async () => {
    const me = await person();
    const { first, second, at } = await twoTurns(me);
    await system.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId: me.spaceId,
        ...at,
        type: "someday.new",
        runId: second.runId,
        payload: {},
      }),
    );
    expect(await revisableIn(me, first.threadId)).toEqual(NOTHING);
  });

  it("edits and regenerates in a bot's extra chat, and never applies to another chat", async () => {
    const me = await person();
    const main = await chat(me);
    const created = await call(me, "dozoChats/create", { botId: main.botId, name: "Garden" });
    expect(created.status).toBe(200);
    const chatId = (created.json.chat as { id: string }).id;
    const at = { threadId: chatId, botId: main.botId };
    const first = await turn(me, at, "Plan the garden");
    const second = await turn(me, at, "Add tomatoes");
    expect(await revisableIn(me, chatId)).toMatchObject({
      editMessageId: second.askId,
      earlierEditMessageIds: [first.askId],
      earlierRegenerateMessageIds: [first.reply.id],
    });
    // The extra chat's message is no message of the main chat's.
    expect(
      (
        await call(me, "dozoMessages/edit", {
          threadId: main.threadId,
          messageId: first.askId,
          text: "x",
        })
      ).status,
    ).toBe(409);
    const regenerated = await call(me, "dozoMessages/regenerate", {
      threadId: chatId,
      messageId: first.reply.id,
    });
    expect(regenerated.status).toBe(200);
    expect(await idsIn(chatId)).toEqual([first.askId]);
    expect(await idsIn(main.threadId)).toEqual([main.askId, main.reply.id]);
    const run = await system.run.findUniqueOrThrow({
      where: { id: regenerated.json.runId as string },
    });
    expect(run).toMatchObject({ threadId: chatId, sourceMessageId: first.askId });
  });

  it("hides another person's chat", async () => {
    const me = await person();
    const turn = await chat(me);
    const stranger = await person();
    const read = await call(stranger, "dozoMessages/revisable", { threadId: turn.threadId });
    expect(read.status).toBe(404);
  });
});
