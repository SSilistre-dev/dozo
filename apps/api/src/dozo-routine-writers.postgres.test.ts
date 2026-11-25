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
  let deps: RouterDeps;
  let call: ReturnType<typeof caller>;
  let dataDir: string;
  const organizations: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".dozo-routine-writers-"));
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
      jobs: {
        enqueue: vi.fn(),
        enqueueIn: async () => undefined,
        enqueueManyIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      memoryProviders: { resolve: async () => null },
      dataDir,
    } as unknown as RouterDeps;
    call = caller(deps);
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

  function caller(routerDeps: RouterDeps) {
    const handler = new RPCHandler(createRouter(routerDeps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
    return async (actor: Actor, path: string, input: unknown) => {
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
    };
  }

  /**
   * The same app on the same database, where writing a routine's record fails inside the save's
   * transaction (as a lost connection would), so the test sees what that transaction committed.
   */
  function routerWithLostRecord() {
    const lose = (tx: object) =>
      new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (key !== "$executeRaw") return value.bind(target);
          return (strings: TemplateStringsArray, ...values: unknown[]) =>
            strings.join("?").includes("dozo_routine_writers")
              ? Promise.reject(new Error("connection lost"))
              : value.call(target, strings, ...values);
        },
      });
    const failing = new Proxy(prisma, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key !== "$transaction") return value.bind(target);
        return (work: unknown, options?: unknown) =>
          typeof work === "function"
            ? value.call(target, (tx: object) => work(lose(tx)), options)
            : value.call(target, work, options);
      },
    });
    return caller({ ...deps, prisma: failing } as RouterDeps);
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

  // A routine runs with its owner's accounts, so only its owner changes it; anyone in the Space may
  // turn it on or off. Another member's text therefore reaches a routine by creating their own.
  it("records another member or a guest creating or saving their own routine as a member, and leaves the owner's alone", async () => {
    const { owner, member, guest, botId } = await setup();
    const routineId = await create(owner, botId);
    for (const someone of [member, guest]) {
      const made = await create(someone, botId);
      expect(await writer(made)).toBe("member");
      expect(
        (await call(someone, "routines/update", { routineId: made, prompt: "Mine again" })).status,
      ).toBe(200);
      expect(await writer(made)).toBe("member");
      // The owner may pause theirs, which sends no text; saving its prompt is refused.
      expect((await call(owner, "routines/update", { routineId: made, active: false })).status).toBe(
        200,
      );
      expect(
        (await call(owner, "routines/update", { routineId: made, prompt: "Owner's" })).status,
      ).toBe(403);
      expect(await writer(made)).toBe("member");
      // Pausing the owner's routine leaves the record; their text is refused and changes nothing.
      expect((await call(someone, "routines/update", { routineId, active: false })).status).toBe(
        200,
      );
      expect(
        (await call(someone, "routines/update", { routineId, prompt: `Theirs ${someone.userId}` }))
          .status,
      ).toBe(403);
      expect(await writer(routineId)).toBe("owner");
    }
  });

  it("records a member's rename of their own routine as theirs", async () => {
    const { owner, member, botId } = await setup();
    const routineId = await create(member, botId);
    expect((await call(member, "routines/update", { routineId, name: "Theirs" })).status).toBe(200);
    expect(await writer(routineId)).toBe("member");
    const ownerRoutine = await create(owner, botId);
    expect(
      (await call(member, "routines/update", { routineId: ownerRoutine, name: "Theirs" })).status,
    ).toBe(403);
    expect(await writer(ownerRoutine)).toBe("owner");
  });

  it("saves nothing when the record cannot be written, so a record never stays on text it did not come with", async () => {
    const { member, botId } = await setup();
    const routineId = await create(member, botId);
    const failing = routerWithLostRecord();
    const before = await system.routine.findUniqueOrThrow({ where: { id: routineId } });
    const saved = await failing(member, "routines/update", { routineId, prompt: "Changed" });
    expect(saved.status).toBe(500);
    const after = await system.routine.findUniqueOrThrow({ where: { id: routineId } });
    expect(after.prompt).toBe(before.prompt);
    expect(after.userId).toBe(member.userId);
    expect(await writer(routineId)).toBe("member");
    const made = await failing(member, "routines/create", {
      botId,
      name: "Never saved",
      prompt: "Theirs",
      crons: ["0 9 * * *"],
    });
    expect(made.status).toBe(500);
    expect(await system.routine.count({ where: { botId, name: "Never saved" } })).toBe(0);
    // A pause writes no record, so it still goes through.
    expect((await failing(member, "routines/update", { routineId, active: false })).status).toBe(
      200,
    );
    expect(await writer(routineId)).toBe("member");
  });

  it("keeps a member's record when they leave and their routine passes to the Space's owner, paused", async () => {
    const { owner, member, botId } = await setup();
    const routineId = await create(member, botId);
    expect((await call(member, "routines/update", { routineId, active: true })).status).toBe(200);
    const removed = await call(owner, "spaces/members/remove", {
      spaceId: owner.spaceId,
      userId: member.userId,
    });
    expect(removed.status).toBe(200);
    const handed = await system.routine.findUniqueOrThrow({ where: { id: routineId } });
    expect(handed).toMatchObject({ userId: owner.userId, active: false });
    expect(await writer(routineId)).toBe("member");
  });
});
