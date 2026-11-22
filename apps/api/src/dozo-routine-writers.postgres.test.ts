import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadEvents, readRoutineWriter } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** Who saved a routine in the app or the API, as the routine routes record it (branded tree). */
describePostgres("who last wrote a routine, through the app (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let dataDir: string;
  const organizations: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-routine-writers-"));
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
      await system.user.deleteMany({ where: { id: { in: users } } });
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

  /** A Space with its owner's bot, another member and a guest who can both message it. */
  async function setup() {
    const id = randomUUID();
    organizations.push(id);
    const createdAt = new Date();
    await system.organization.create({ data: { id, name: "Team", slug: id, createdAt } });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
    const person = async (role: string, spaceRole: string): Promise<Actor> => {
      const userId = randomUUID();
      users.push(userId);
      const email = `${userId}@example.test`;
      await system.user.create({ data: { id: userId, name: "P", email, emailVerified: true } });
      await system.member.create({
        data: { id: userId, organizationId: id, userId, role, createdAt },
      });
      await system.spaceMember.create({
        data: { id: userId, spaceId: id, organizationId: id, userId, role: spaceRole, createdAt },
      });
      return { spaceId: id, userId, email, isDeploymentOwner: false };
    };
    const owner = await person("owner", "owner");
    const member = await person("member", "member");
    const guest = await person("guest", "member");
    const bot = await system.bot.create({
      data: { spaceId: id, userId: owner.userId, name: "Chef", color: "test" },
    });
    await system.thread.create({ data: { spaceId: id, userId: owner.userId, botId: bot.id } });
    return { owner, member, guest, botId: bot.id };
  }

  // Read as the system: the test asks what was written, not who may read it.
  const writer = async (routineId: string) => (await readRoutineWriter(system, routineId))?.writer;

  const create = async (actor: Actor, botId: string) => {
    const created = await call(actor, "routines/create", {
      botId,
      name: `Digest ${randomUUID()}`,
      prompt: "Summarize",
      crons: ["0 9 * * *"],
    });
    expect(created.status).toBe(200);
    return created.json.id as string;
  };

  it("records the bot's owner creating and saving a routine as the owner", async () => {
    const { owner, botId } = await setup();
    const routineId = await create(owner, botId);
    expect(await writer(routineId)).toBe("owner");
    expect((await call(owner, "routines/update", { routineId, prompt: "Shorter" })).status).toBe(
      200,
    );
    expect(await writer(routineId)).toBe("owner");
  });

  it("records another member or a guest creating or saving it as a member, until the owner saves it", async () => {
    const { owner, member, guest, botId } = await setup();
    for (const someone of [member, guest]) {
      const made = await create(someone, botId);
      expect(await writer(made)).toBe("member");
    }
    const routineId = await create(owner, botId);
    for (const someone of [member, guest]) {
      expect((await call(someone, "routines/update", { routineId, active: false })).status).toBe(
        200,
      );
      expect(await writer(routineId)).toBe("member");
      expect((await call(owner, "routines/update", { routineId, active: true })).status).toBe(200);
      expect(await writer(routineId)).toBe("owner");
    }
  });
});
