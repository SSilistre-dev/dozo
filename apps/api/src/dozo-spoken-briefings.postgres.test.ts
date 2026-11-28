import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, createThreadEvents, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("spoken briefing settings (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];

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
      jobs: { enqueue: vi.fn() },
      memoryProviders: { resolve: async () => null },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-briefings-test",
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

  async function person(): Promise<Actor> {
    const id = `briefings-${randomUUID()}`;
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

  /** Another person, joined to the owner's organization and Space. */
  async function memberOf(owner: Actor): Promise<Actor> {
    const other = await person();
    const createdAt = new Date();
    await system.member.create({
      data: {
        id: `m-${other.userId}-joined`,
        organizationId: owner.userId,
        userId: other.userId,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: owner.spaceId,
        organizationId: owner.userId,
        userId: other.userId,
        role: "member",
        createdAt,
      },
    });
    return { ...other, spaceId: owner.spaceId };
  }

  async function bot(actor: Actor, name: string, voiceId: string | null) {
    const created = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    await system.bot.update({ where: { id: created.id }, data: { voiceId } });
    return created.id;
  }

  async function routine(actor: Actor, botId: string) {
    const row = await system.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        userId: actor.userId,
        name: "Orders",
        prompt: "Sum up",
        crons: [],
      },
    });
    return row.id;
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

  it("saves and clears the owner's pick among their own voiced bots", async () => {
    const owner = await person();
    const host = await bot(owner, "Chef", "voice-a");
    const nova = await bot(owner, "Nova", "voice-b");
    await bot(owner, "Mute", null);
    const routineId = await routine(owner, host);
    const read = await call(owner, "dozoSpokenBriefings/get", { routineId });
    expect(read.json).toEqual({
      available: false,
      coHostBotId: null,
      coHosts: [{ id: nova, name: "Nova" }],
    });
    const saved = await call(owner, "dozoSpokenBriefings/set", { routineId, coHostBotId: nova });
    expect(saved.json.coHostBotId).toBe(nova);
    const again = await call(owner, "dozoSpokenBriefings/set", { routineId, coHostBotId: nova });
    expect(again.status).toBe(200);
    const off = await call(owner, "dozoSpokenBriefings/set", { routineId, coHostBotId: null });
    expect(off.json.coHostBotId).toBeNull();
    expect(
      await system.$queryRaw`SELECT 1 FROM dozo_spoken_briefings WHERE "routineId" = ${routineId}`,
    ).toEqual([]);
  });

  it("refuses another member's routine and another member's bot as not found", async () => {
    const owner = await person();
    const member = await memberOf(owner);
    const host = await bot(owner, "Chef", "voice-a");
    const theirs = await bot(member, "Theirs", "voice-c");
    const routineId = await routine(owner, host);
    expect((await call(member, "dozoSpokenBriefings/get", { routineId })).status).toBe(404);
    expect(
      (await call(member, "dozoSpokenBriefings/set", { routineId, coHostBotId: null })).status,
    ).toBe(404);
    expect(
      (await call(owner, "dozoSpokenBriefings/set", { routineId, coHostBotId: theirs })).status,
    ).toBe(404);
    expect(
      await system.$queryRaw`SELECT 1 FROM dozo_spoken_briefings WHERE "routineId" = ${routineId}`,
    ).toEqual([]);
  });
});
