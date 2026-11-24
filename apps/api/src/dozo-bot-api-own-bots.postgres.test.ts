import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadEvents } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DozoTokenCaller } from "./dozo-access-tokens.js";
import { dozoBotApiDeps, dozoRouterConnector, mountDozoBotApi } from "./dozo-bot-api.js";
import { dozoMcpOperations } from "./dozo-mcp.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleHttpError, handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const TOKEN = "Bearer test-token";

/**
 * A token reaches only its member's own bots: in a Space A shares with C, C's token reaches C's
 * bot and never A's, though the app lets C talk to A's bot. Against the app's routes and a real
 * database.
 */
describePostgres("a member's token in a shared Space (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let router: ReturnType<typeof createRouter>;
  let rpc: RPCHandler<Record<string, unknown>>;
  let dataDir: string;
  const organizations: string[] = [];
  const users: string[] = [];
  let world: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-bot-api-own-bots-"));
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
    world = await setup();
  });

  afterAll(async () => {
    if (prisma) {
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function rpcStatus(actor: Actor, path: string, input: unknown) {
    const { response } = await rpc.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response!.status;
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

  async function person(name: string) {
    const id = randomUUID();
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.spaceMember.create({
      data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return id;
  }

  /** A shares Space S with C; each has a bot in S, and C has one in C's own Space too. */
  async function setup() {
    const a = await person("Ada");
    const c = await person("Cem");
    const createdAt = new Date();
    const s = randomUUID();
    organizations.push(s);
    await system.organization.create({ data: { id: s, name: "Shared", slug: s, createdAt } });
    await system.space.create({ data: { id: s, organizationId: s, name: "Shared" } });
    for (const [userId, role] of [
      [a, "owner"],
      [c, "member"],
    ] as const) {
      const id = randomUUID();
      await system.member.create({ data: { id, organizationId: s, userId, role, createdAt } });
      await system.spaceMember.create({
        data: { id, spaceId: s, organizationId: s, userId, role, createdAt },
      });
    }
    const actor = (userId: string, spaceId: string): Actor => ({
      userId,
      spaceId,
      email: `${userId}@example.test`,
      isDeploymentOwner: false,
    });
    return {
      cInS: actor(c, s),
      cHome: actor(c, c),
      aBot: await newBot(s, a, "Chef"),
      cBot: await newBot(s, c, "Scout"),
      cHomeBot: await newBot(c, c, "Home"),
    };
  }

  function api(actor: Actor, botId: string | null = null) {
    const caller: DozoTokenCaller = { tokenId: randomUUID(), actor, botId };
    const hono = new Hono();
    hono.onError(handleHttpError);
    mountDozoBotApi(hono, {
      ...dozoBotApiDeps(prisma, router, () => "203.0.113.5"),
      authenticate: async (header) => (header === TOKEN ? caller : null),
      touch: async () => undefined,
    });
    const call = (path: string, init: RequestInit = {}) =>
      hono.request(`http://api.test/api/v1/dozo${path}`, {
        ...init,
        headers: { authorization: TOKEN, ...(init.headers as Record<string, string>) },
      });
    const send = (botId: string, text: string) =>
      call(`/bots/${botId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    return { caller, call, send };
  }

  const messagesIn = (threadId: string) => system.message.count({ where: { threadId } });

  it("lists only the member's own bot of the shared Space", async () => {
    const { cInS, aBot, cBot } = world;
    // The app itself lists both to C and lets C read A's bot's chat.
    expect(await rpcStatus(cInS, "threads/head", { botId: aBot.botId })).toBe(200);
    const listed = await api(cInS).call("/bots");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { bots: { id: string }[] }).bots).toEqual([
      { id: cBot.botId, name: "Scout" },
    ]);
  });

  it("answers the other member's bot exactly as a bot that does not exist, writing nothing", async () => {
    const { cInS, aBot } = world;
    const { call, send } = api(cInS);
    const answers = async (botId: string) => {
      const all = [
        await call(`/bots/${botId}/messages`),
        await call(`/bots/${botId}/chats`),
        await call(`/bots/${botId}/export`),
        await call(`/bots/${botId}/runs/${randomUUID()}/events`),
        await send(botId, "hello from a token"),
      ];
      return Promise.all(all.map(async (answer) => [answer.status, await answer.text()]));
    };
    const before = await messagesIn(aBot.mainId);
    const others = await answers(aBot.botId);
    expect(others).toEqual(await answers(randomUUID()));
    expect(others.map(([status]) => status)).toEqual([404, 404, 404, 404, 404]);
    expect(await messagesIn(aBot.mainId)).toBe(before);
    // A token made for A's bot reaches it no better.
    const bound = api(cInS, aBot.botId);
    expect((await bound.call(`/bots/${aBot.botId}/messages`)).status).toBe(404);
    expect(await (await bound.call("/bots")).json()).toEqual({ bots: [] });
  });

  it("still reaches the member's own bot in the shared Space", async () => {
    const { cInS, cBot } = world;
    const { call, send } = api(cInS);
    expect((await call(`/bots/${cBot.botId}/messages`)).status).toBe(200);
    expect((await call(`/bots/${cBot.botId}/chats`)).status).toBe(200);
    expect((await send(cBot.botId, "hello")).status).toBe(202);
    expect(await messagesIn(cBot.mainId)).toBeGreaterThan(0);
  });

  it("keeps a token in the member's own Space on its bots, as before", async () => {
    const { cHome, cHomeBot } = world;
    const { call } = api(cHome);
    expect(await (await call("/bots")).json()).toEqual({
      bots: [{ id: cHomeBot.botId, name: "Home" }],
    });
    expect((await call(`/bots/${cHomeBot.botId}/messages`)).status).toBe(200);
  });

  it("gives the MCP endpoint the same bots", async () => {
    const { cInS, aBot, cBot } = world;
    const { caller } = api(cInS);
    const client = dozoRouterConnector(router)({
      actor: cInS,
      dozoAccessTokenId: caller.tokenId,
      signal: new AbortController().signal,
      stillAuthorized: async () => true,
    });
    const ops = dozoMcpOperations(prisma, cInS, null, client, async () => undefined);
    expect((await ops.listBots()).map((bot) => bot.id)).toEqual([cBot.botId]);
    await expect(ops.listChats(aBot.botId)).rejects.toThrow("No such bot.");
  });
});
