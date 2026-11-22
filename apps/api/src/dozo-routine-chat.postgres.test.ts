import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadEvents } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** Pointing a routine at one of its bot's chats, through the app's own routes. */
describePostgres("the chat a routine posts in, through the app (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-routine-chat-"));
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

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: Record<string, unknown> };
    return { status: response!.status, json: body.json };
  }

  async function bot(actor: Actor, name: string) {
    const scopeKey = randomUUID();
    const computer = await system.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scopeKey,
        homeKey: scopeKey,
        kind: "fake",
        state: "running",
      },
    });
    const made = await system.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name,
        color: "test",
        computerId: computer.id,
      },
    });
    const main = await system.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, botId: made.id },
    });
    return { botId: made.id, mainId: main.id };
  }

  /** A person's Space with Chef (an open and an archived extra chat), Scout (one) and a routine. */
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
    const chef = await bot(actor, "Chef");
    const scout = await bot(actor, "Scout");
    const chat = async (botId: string, name: string) =>
      ((await call(actor, "dozoChats/create", { botId, name })).json.chat as { id: string }).id;
    const garden = await chat(chef.botId, "Garden");
    const old = await chat(chef.botId, "Old");
    await call(actor, "dozoChats/archive", { chatId: old, archived: true });
    const trails = await chat(scout.botId, "Trails");
    const created = await call(actor, "routines/create", {
      botId: chef.botId,
      name: "Digest",
      prompt: "Summarize",
      crons: ["0 9 * * *"],
    });
    expect(created.status).toBe(200);
    const routineId = created.json.id as string;
    return { actor, chef, scout, garden, old, trails, routineId };
  }

  const threadOf = async (routineId: string) =>
    (await system.routine.findUniqueOrThrow({ where: { id: routineId } })).threadId;

  it("leaves a routine made in the app on the main chat, as before", async () => {
    const { actor, routineId } = await setup();
    expect(await threadOf(routineId)).toBeNull();
    expect((await call(actor, "dozoChats/routineChat", { routineId })).json).toEqual({
      chatId: null,
      editable: true,
    });
  });

  it("points a routine at an open extra chat of its bot and back, and Run now posts there", async () => {
    const { actor, chef, garden, routineId } = await setup();
    const set = await call(actor, "dozoChats/setRoutineChat", { routineId, chatId: garden });
    expect(set).toEqual({ status: 200, json: { chatId: garden, editable: true } });
    expect(await threadOf(routineId)).toBe(garden);
    expect((await call(actor, "dozoChats/routineChat", { routineId })).json).toEqual({
      chatId: garden,
      editable: true,
    });
    const tested = await call(actor, "routines/testRun", { routineId, clientNonce: randomUUID() });
    expect(tested.status).toBe(200);
    const run = await system.run.findUniqueOrThrow({ where: { id: tested.json.runId as string } });
    expect(run.threadId).toBe(garden);
    expect(await system.task.count({ where: { threadId: chef.mainId } })).toBe(0);
    // Editing the routine elsewhere (as the phone does) keeps its chat.
    expect((await call(actor, "routines/update", { routineId, name: "Morning" })).status).toBe(200);
    expect(await threadOf(routineId)).toBe(garden);
    await call(actor, "dozoChats/setRoutineChat", { routineId, chatId: null });
    expect(await threadOf(routineId)).toBeNull();
  });

  it("runs Run now in the main chat while the routine's chat is archived, and shows the main chat", async () => {
    const { actor, chef, garden, routineId } = await setup();
    await call(actor, "dozoChats/setRoutineChat", { routineId, chatId: garden });
    await call(actor, "dozoChats/archive", { chatId: garden, archived: true });
    expect((await call(actor, "dozoChats/routineChat", { routineId })).json).toEqual({
      chatId: null,
      editable: true,
    });
    const tested = await call(actor, "routines/testRun", { routineId, clientNonce: randomUUID() });
    const run = await system.run.findUniqueOrThrow({ where: { id: tested.json.runId as string } });
    expect(run.threadId).toBe(chef.mainId);
    expect(await threadOf(routineId)).toBe(garden);
  });

  it("refuses every chat that cannot take the routine as not found, changing nothing", async () => {
    const mine = await setup();
    const theirs = await setup();
    const { actor, routineId } = mine;
    const refused = {
      "another bot's, same Space": mine.trails,
      "another Space's": theirs.garden,
      archived: mine.old,
      "no chat at all": randomUUID(),
      "the main chat's own id": mine.chef.mainId,
    };
    for (const [what, chatId] of Object.entries(refused)) {
      const answer = await call(actor, "dozoChats/setRoutineChat", { routineId, chatId });
      expect({ what, status: answer.status }).toEqual({ what, status: 404 });
    }
    expect(await threadOf(routineId)).toBeNull();
    // Someone in another Space can neither read nor point my routine.
    expect((await call(theirs.actor, "dozoChats/routineChat", { routineId })).status).toBe(404);
    const crossed = await call(theirs.actor, "dozoChats/setRoutineChat", {
      routineId,
      chatId: theirs.garden,
    });
    expect(crossed.status).toBe(404);
    expect(await threadOf(routineId)).toBeNull();
  });
});
