import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  LocalAgentHomeStore,
} from "@rakazo/adapters";
import type { AccountExportRecord, Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  asSystem,
  countUnreadInboxChats,
  createDb,
  createThreadEvents,
  createThreadMessageInTransaction,
  readAccountExport,
  runAsTenant,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

type Snapshot = { threadId: string; messages: Array<{ id: string; blocks: unknown }> };

/** Using a bot's extra chat through the app's own routes and the run executor. */
describePostgres("using a bot's extra chat (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let deps: RouterDeps;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-bot-chats-use-"));
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", defaultModelProvider: "openrouter", defaultModelId: "fake" },
      update: {},
    });
    deps = {
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
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir,
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** A person with their own Space, and a bot with a computer and its main chat. */
  async function setup() {
    const id = randomUUID();
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Chef", color: "test", computerId: computer.id },
    });
    const main = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const created = await call(actor, "dozoChats/create", { botId: bot.id, name: "Garden" });
    expect(created.status).toBe(200);
    const chatId = (created.json.chat as { id: string }).id;
    return { actor, botId: bot.id, mainId: main.id, chatId };
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

  const send = (actor: Actor, target: object, text: string) =>
    call(actor, "threads/send", { ...target, text, clientNonce: randomUUID() });
  const snapshot = async (actor: Actor, target: object) =>
    (await call(actor, "threads/get", target)).json as unknown as Snapshot;
  const texts = (snap: Snapshot) => JSON.stringify(snap.messages.map((message) => message.blocks));

  /** A bot message in a chat, as a run's reply leaves it. */
  async function botSays(threadId: string, botId: string, spaceId: string, text: string) {
    await system.$transaction(async (tx) => {
      const blocks = [{ kind: "text" as const, text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        botId,
        blocks,
      });
      await appendEventInTransaction(tx, {
        spaceId,
        threadId,
        botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
    });
  }

  it("sends, reads and starts a run in the extra chat, and leaves the main chat as it was", async () => {
    const { actor, botId, mainId, chatId } = await setup();
    const mainBefore = await snapshot(actor, { botId });
    const sent = await send(actor, { botId, chatId }, "Plan the garden");
    expect(sent.status).toBe(200);
    const extra = await snapshot(actor, { botId, chatId });
    expect(extra.threadId).toBe(chatId);
    expect(texts(extra)).toContain("Plan the garden");
    const main = await snapshot(actor, { botId });
    expect(main.threadId).toBe(mainId);
    expect(texts(main)).not.toContain("Plan the garden");
    expect(main.messages).toEqual(mainBefore.messages);
    const runs = await system.run.findMany({ where: { botId }, select: { threadId: true } });
    expect(runs).toEqual([{ threadId: chatId }]);
    expect((await call(actor, "threads/head", { botId, chatId })).status).toBe(200);
  });

  it("keeps two chats of one bot working side by side", async () => {
    const { actor, botId, mainId, chatId } = await setup();
    const [main, extra] = await Promise.all([
      send(actor, { botId }, "Main question"),
      send(actor, { botId, chatId }, "Garden question"),
    ]);
    expect([main.status, extra.status]).toEqual([200, 200]);
    const runs = await system.run.findMany({
      where: { botId },
      select: { threadId: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    expect(runs.map((run) => run.threadId).sort()).toEqual([chatId, mainId].sort());
    expect(texts(await snapshot(actor, { botId }))).not.toContain("Garden question");
    expect(texts(await snapshot(actor, { botId, chatId }))).not.toContain("Main question");
  });

  it("refuses another bot's or another Space's chat, never answering with the main chat", async () => {
    const mine = await setup();
    const theirs = await setup();
    // Another bot's chat named under my bot.
    expect(
      (await call(mine.actor, "threads/get", { botId: mine.botId, chatId: theirs.chatId })).status,
    ).toBe(404);
    // My chat, asked for by someone else under their own bot and under mine.
    expect(
      (await call(theirs.actor, "threads/get", { botId: theirs.botId, chatId: mine.chatId }))
        .status,
    ).toBe(404);
    expect(
      (await call(theirs.actor, "threads/get", { botId: mine.botId, chatId: mine.chatId })).status,
    ).toBe(404);
    expect(
      (await send(theirs.actor, { botId: mine.botId, chatId: mine.chatId }, "hi")).status,
    ).toBe(404);
    expect(await system.message.count({ where: { threadId: mine.chatId } })).toBe(0);
  });

  it("keeps unread, read and snooze per chat, and counts an unread chat until it is archived", async () => {
    const { actor, botId, chatId } = await setup();
    await botSays(chatId, botId, actor.spaceId, "Tomatoes need sun.");
    const listed = async () =>
      (
        (await call(actor, "dozoChats/list", {})).json.chats as Array<{
          id: string;
          unread: boolean;
          snoozedUntil: string | null;
        }>
      )[0]!;
    expect(await listed()).toMatchObject({ id: chatId, unread: true, snoozedUntil: null });
    const inbox = () =>
      countUnreadInboxChats(prisma, { userId: actor.userId, spaceId: actor.spaceId });
    expect(await inbox()).toBe(1);
    expect((await call(actor, "threads/markRead", { botId, chatId })).status).toBe(200);
    expect((await listed()).unread).toBe(false);
    expect(await inbox()).toBe(0);
    expect((await call(actor, "threads/markUnread", { botId, chatId })).status).toBe(200);
    expect((await listed()).unread).toBe(true);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call(actor, "threads/snooze", { botId, chatId, until })).status).toBe(200);
    expect(Date.parse((await listed()).snoozedUntil ?? "")).toBe(Date.parse(until));
    expect((await call(actor, "threads/snooze", { botId, chatId, until: null })).status).toBe(200);
    expect(await inbox()).toBe(1);
    await call(actor, "dozoChats/archive", { chatId, archived: true });
    expect(await inbox()).toBe(0);
  });

  it("finds the extra chat's messages in search, naming the chat", async () => {
    const { actor, botId, chatId } = await setup();
    await botSays(chatId, botId, actor.spaceId, "Basil grows well beside tomatoes.");
    const { hits } = (await call(actor, "search/query", { q: "basil" })).json as {
      hits: Array<{ kind: string; botId?: string; chatId?: string }>;
    };
    expect(hits).toContainEqual(expect.objectContaining({ kind: "message", botId, chatId }));
  });

  it("pins, offers revision and exports in the extra chat; clearing it is refused", async () => {
    const { actor, botId, mainId, chatId } = await setup();
    await botSays(chatId, botId, actor.spaceId, "Water at dawn.");
    await botSays(mainId, botId, actor.spaceId, "Main chat words.");
    const message = await system.message.findFirstOrThrow({ where: { threadId: chatId } });
    expect(
      (
        await call(actor, "dozoMessages/pin", {
          threadId: chatId,
          messageId: message.id,
          pinned: true,
        })
      ).status,
    ).toBe(200);
    expect((await call(actor, "dozoMessages/pins", { threadId: chatId })).json.pins).toHaveLength(
      1,
    );
    expect((await call(actor, "dozoMessages/revisable", { threadId: chatId })).status).toBe(200);
    const exported = await call(actor, "dozoChatExport/markdown", { botId, chatId });
    expect(exported.json.markdown).toContain("Water at dawn.");
    expect(exported.json.markdown).not.toContain("Main chat words.");
    const cleared = await call(actor, "threads/clear", { botId, chatId });
    expect(cleared.status).toBe(400);
    expect(cleared.json).toMatchObject({ code: "dozo_extra_chat_unsupported" });
    expect(await system.message.count({ where: { threadId: chatId } })).toBe(1);
    expect(await system.message.count({ where: { threadId: mainId } })).toBe(1);
  });

  it("takes the extra chats and their messages into the account archive", async () => {
    const { actor, botId, chatId } = await setup();
    await botSays(chatId, botId, actor.spaceId, "Compost in autumn.");
    const source = await readAccountExport(prisma, actor.userId);
    const records: AccountExportRecord[] = [];
    for await (const record of source.spaces[0]!.records()) records.push(record);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "thread",
        id: chatId,
        botId: null,
        dozoChat: { botId, name: "Garden", archivedAt: null },
      }),
    );
    expect(records).toContainEqual(expect.objectContaining({ type: "message", threadId: chatId }));
  });

  it("runs a turn in the extra chat on that chat's history, with its tool step and its question card", async () => {
    const { actor, botId, mainId, chatId } = await setup();
    await botSays(mainId, botId, actor.spaceId, "Main chat only.");
    await botSays(chatId, botId, actor.spaceId, "Earlier garden note.");
    await send(actor, { botId, chatId }, "Which seeds first?");
    const run = await system.run.findFirstOrThrow({ where: { threadId: chatId } });
    const requests: AgentRunRequest[] = [];
    const runtime = {
      describe: () => ({
        id: "dozo-chat-fixture",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request);
        yield {
          type: "tool" as const,
          name: "web_search",
          args: { q: "seeds" },
          executionId: "e1",
        };
        yield { type: "ask" as const, text: "Indoors or outdoors?" };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: deps.events,
      jobs: deps.jobs,
      sandbox: new FakeSandboxProvider(),
      browser: new FakeBrowserProvider(),
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await runAsTenant(actor, () => executor.continueRun(run.id, "chat-worker"));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain("Which seeds first?");
    // Its history is the extra chat's, never the main chat's.
    const request = JSON.stringify(requests[0]);
    expect(JSON.stringify(requests[0]!.history)).toContain("Earlier garden note.");
    expect(request).not.toContain("Main chat only.");
    const extra = await snapshot(actor, { botId, chatId });
    expect(texts(extra)).toContain(`"kind":"steps"`);
    expect(texts(extra)).toContain("Web search");
    expect(texts(extra)).toContain("Indoors or outdoors?");
    expect(texts(await snapshot(actor, { botId }))).not.toContain("Indoors or outdoors?");
    expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "waiting_input",
    );
    const card = await system.message.findFirstOrThrow({
      where: { threadId: chatId, runId: run.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const answered = await call(actor, "threads/answer", {
      botId,
      chatId,
      runId: run.id,
      messageId: card.id,
      answer: "Indoors",
    });
    expect(answered.status).toBe(200);
    // The answer went to that chat's card, and nothing reached the main chat.
    expect(texts(await snapshot(actor, { botId, chatId }))).toContain("Indoors");
    expect(texts(await snapshot(actor, { botId }))).not.toContain("Indoors");
  });
});
