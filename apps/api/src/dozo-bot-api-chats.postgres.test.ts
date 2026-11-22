import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { MessagingDelivery } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DozoTokenCaller } from "./dozo-access-tokens.js";
import { dozoBotApiDeps, mountDozoBotApi } from "./dozo-bot-api.js";
import { createChat } from "./dozo-bot-chats.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleHttpError, handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const TOKEN = "Bearer test-token";

/**
 * The bot API and a chat app on a bot with extra chats, against the app's own routes and a real
 * database: which chat each call reaches, and that nothing it cannot reach is ever the main chat.
 */
describePostgres("a bot's extra chats through the bot API and chat apps (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let router: ReturnType<typeof createRouter>;
  let rpc: RPCHandler<Record<string, unknown>>;
  let dataDir: string;
  const organizations: string[] = [];
  const addresses: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-bot-api-chats-"));
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
      jobs: { enqueue: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      memoryProviders: { resolve: async () => null },
      dataDir,
    } as unknown as RouterDeps;
    router = createRouter(deps);
    rpc = new RPCHandler(router, {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await system.messagingIdentity.deleteMany({ where: { address: { in: addresses } } });
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function rpcCall(actor: Actor, path: string, input: unknown) {
    const { response } = await rpc.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: Record<string, unknown> };
    expect(response!.status).toBe(200);
    return body.json;
  }

  async function newBot(spaceId: string, userId: string, name: string) {
    const scopeKey = randomUUID();
    const computer = await system.computer.create({
      data: { spaceId, userId, scopeKey, homeKey: scopeKey, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId, name, color: "test", computerId: computer.id },
    });
    const main = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    return { botId: bot.id, mainId: main.id };
  }

  /** A person's own Space with two bots; the first has an open and an archived extra chat. */
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
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const chef = await newBot(id, id, "Chef");
    const scout = await newBot(id, id, "Scout");
    const chat = async (botId: string, name: string) =>
      ((await rpcCall(actor, "dozoChats/create", { botId, name })).chat as { id: string }).id;
    const garden = await chat(chef.botId, "Garden");
    const old = await chat(chef.botId, "Old");
    await rpcCall(actor, "dozoChats/archive", { chatId: old, archived: true });
    const scouting = await chat(scout.botId, "Trails");
    return { actor, chef, scout, garden, old, scouting };
  }

  function api(caller: DozoTokenCaller) {
    const hono = new Hono();
    hono.onError(handleHttpError);
    mountDozoBotApi(hono, {
      ...dozoBotApiDeps(prisma, router, () => "203.0.113.5"),
      authenticate: async (header) => (header === TOKEN ? caller : null),
      touch: async () => undefined,
      // Each test's token is new, so the shared per-minute counts never hold it back.
    });
    const call = (path: string, init: RequestInit = {}) =>
      hono.request(`http://api.test/api/v1/dozo${path}`, {
        ...init,
        headers: { authorization: TOKEN, ...(init.headers as Record<string, string>) },
      });
    const send = (botId: string, text: string, query = "") =>
      call(`/bots/${botId}/messages${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    return { call, send };
  }

  const tokenFor = (actor: Actor, botId: string | null = null): DozoTokenCaller => ({
    tokenId: randomUUID(),
    actor,
    botId,
  });
  const textsIn = async (threadId: string) =>
    (
      await system.message.findMany({
        where: { threadId },
        select: { blocks: true },
        orderBy: { seq: "asc" },
      })
    ).map((message) => JSON.stringify(message.blocks));

  it("lists only the bot's open extra chats", async () => {
    const { actor, chef, garden } = await setup();
    const listed = await api(tokenFor(actor)).call(`/bots/${chef.botId}/chats`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { chats: Array<Record<string, unknown>> };
    expect(body.chats).toEqual([{ id: garden, name: "Garden", createdAt: expect.any(String) }]);
  });

  it("keeps a call without a chat on the main chat, exactly as before", async () => {
    const { actor, chef, garden } = await setup();
    const { call, send } = api(tokenFor(actor));
    expect((await send(chef.botId, "Main question")).status).toBe(202);
    expect(await textsIn(chef.mainId)).toEqual([expect.stringContaining("Main question")]);
    expect(await textsIn(garden)).toEqual([]);
    const page = (await (await call(`/bots/${chef.botId}/messages`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(page.messages.map((message) => message.text)).toEqual(["Main question"]);
    const exported = (await (await call(`/bots/${chef.botId}/export`)).json()) as {
      markdown: string;
    };
    expect(exported.markdown).toContain("Main question");
  });

  it("sends, reads, follows and exports in an open extra chat, leaving the main chat alone", async () => {
    const { actor, chef, garden } = await setup();
    const { call, send } = api(tokenFor(actor));
    const sent = await send(chef.botId, "When do I sow tomatoes?", `?chat=${garden}`);
    expect(sent.status).toBe(202);
    const { runId } = (await sent.json()) as { runId: string };
    expect(await textsIn(garden)).toEqual([expect.stringContaining("sow tomatoes")]);
    expect(await textsIn(chef.mainId)).toEqual([]);
    expect(await system.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      threadId: garden,
    });
    const page = (await (await call(`/bots/${chef.botId}/messages?chat=${garden}`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(page.messages.map((message) => message.text)).toEqual(["When do I sow tomatoes?"]);
    const exported = (await (await call(`/bots/${chef.botId}/export?chat=${garden}`)).json()) as {
      markdown: string;
    };
    expect(exported.markdown).toContain("sow tomatoes");
    // The run is the chat's: followed there, and not found in the main chat.
    await system.run.update({ where: { id: runId }, data: { status: "completed" } });
    const followed = await call(`/bots/${chef.botId}/runs/${runId}/events?chat=${garden}`);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain('"status":"completed"');
    expect((await call(`/bots/${chef.botId}/runs/${runId}/events`)).status).toBe(404);
  });

  it("answers every chat it cannot reach with one 404, writing nowhere", async () => {
    const mine = await setup();
    const theirs = await setup();
    const { call, send } = api(tokenFor(mine.actor));
    const bot = mine.chef.botId;
    const unreachable = {
      "another bot's, same Space": mine.scouting,
      "another Space's": theirs.garden,
      archived: mine.old,
      "no chat at all": randomUUID(),
      "the main chat's own id": mine.chef.mainId,
      empty: "",
    };
    const threads = [mine.chef.mainId, mine.garden, mine.old, mine.scouting, theirs.garden];
    for (const [what, chat] of Object.entries(unreachable)) {
      const query = `?chat=${encodeURIComponent(chat)}`;
      const answers = [
        await send(bot, `to ${what}`, query),
        await call(`/bots/${bot}/messages${query}`),
        await call(`/bots/${bot}/export${query}`),
        await call(`/bots/${bot}/runs/${randomUUID()}/events${query}`),
      ];
      for (const answer of answers) {
        expect({ what, status: answer.status }).toEqual({ what, status: 404 });
        expect(await answer.json()).toEqual({ error: "Chat not found" });
      }
    }
    for (const threadId of threads) expect(await textsIn(threadId)).toEqual([]);
    expect(await system.run.count({ where: { threadId: { in: threads } } })).toBe(0);
  });

  it("reaches no other bot's chats with a token limited to one bot", async () => {
    const { actor, chef, scout, garden } = await setup();
    const { call, send } = api(tokenFor(actor, scout.botId));
    expect((await call(`/bots/${chef.botId}/chats`)).status).toBe(404);
    expect((await send(chef.botId, "hi", `?chat=${garden}`)).status).toBe(404);
    expect((await call(`/bots/${scout.botId}/chats`)).status).toBe(200);
    expect(await textsIn(garden)).toEqual([]);
  });

  it("takes a message from a chat app into the bot's main chat, never one of its extra chats", async () => {
    // Pinned as it is today: a linked conversation reaches the bot's main chat. Which extra chat
    // a conversation should reach instead is a product decision not made yet.
    const address = `person-${randomUUID()}`;
    addresses.push(address);
    const linked = await runAsSystem("chat app fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "telegram", address }),
    );
    // Its organization has the Space's id; the person is deleted with the others by id.
    organizations.push(linked.spaceId, linked.userId);
    await system.messagingIdentity.update({
      where: { botId: linked.botId },
      data: { dmThreadId: `telegram:${address}` },
    });
    const actor: Actor = {
      spaceId: linked.spaceId,
      userId: linked.userId,
      email: `${linked.userId}@example.test`,
      isDeploymentOwner: false,
    };
    // An extra chat made after the main one, the newest chat of the bot.
    const extra = await system.$transaction((tx) =>
      createChat(tx, actor, { botId: linked.botId, name: "Garden" }),
    );
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      enqueueIn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      cancelIn: vi.fn(async () => undefined),
    };
    const recorder = new MessagingDelivery({
      prisma: system,
      messaging: {} as never,
      events: createThreadEvents(system),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const inbound = createMessagingInboundHandler({
      prisma: system,
      events: createThreadEvents(system),
      jobs,
      delivery: { recordIn: recorder.recordIn.bind(recorder), send: vi.fn(async () => undefined) },
      sandbox: {} as never,
      provision: vi.fn(),
      openSignup: false,
    });
    const handle = `in-${randomUUID()}`;
    await runAsSystem("a message from a chat app", () =>
      inbound({
        type: "message",
        provider: "telegram",
        handle,
        threadId: `telegram:${address}`,
        isDirect: true,
        from: address,
        fromLabel: null,
        channelName: null,
        participants: [address],
        content: "Water the tomatoes",
        mediaUrl: null,
      }),
    );
    const landed = await system.message.findFirstOrThrow({
      where: { clientNonce: `messaging:telegram:${handle}` },
      select: { threadId: true },
    });
    expect(landed.threadId).toBe(linked.threadId);
    expect(await textsIn(extra.id)).toEqual([]);
  });
});
