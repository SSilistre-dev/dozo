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

describePostgres("computers wall (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const enqueue = vi.fn();
  const connectScreen = vi.fn();
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `wall-${randomUUID()}`;
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

  /** Another person, a member of `owner`'s Space beside their own. */
  async function memberOf(owner: Actor): Promise<Actor> {
    const other = await person();
    const space = await system.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    const createdAt = new Date();
    await system.member.create({
      data: {
        id: `m-${other.userId}-shared`,
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: owner.spaceId,
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt,
      },
    });
    return { ...other, spaceId: owner.spaceId };
  }

  /** A bot whose computer is running now, as a start leaves it. */
  async function runningBot(actor: Actor) {
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Scout",
        description: "",
        instructions: "Browse.",
        notifyOnFinish: false,
      }),
    );
    const { computerId } = await system.bot.findUniqueOrThrow({ where: { id: bot.id } });
    await system.computer.update({
      where: { id: computerId! },
      data: {
        kind: "fake",
        state: "running",
        providerRef: `ref-${bot.id}`,
        runningSince: new Date(),
      },
    });
    return bot.id;
  }

  async function call(actor: Actor, path: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: unknown };
    return { status: response!.status, json: body.json };
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
      sandbox: { connectScreen },
      dataDir: "/tmp/rakazo-wall-test",
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

  it("lists the caller's running computer with a screen, and reading it touches nothing", async () => {
    const me = await person();
    const botId = await runningBot(me);
    const listed = await call(me, "dozoComputerWall/list");
    expect(listed).toEqual({ status: 200, json: [{ botId, state: "running", screen: true }] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(connectScreen).not.toHaveBeenCalled();
  });

  it("streams only a member's own bots in a shared Space, and shows the others' as their bot", async () => {
    const owner = await person();
    const ownerBot = await runningBot(owner);
    const member = await memberOf(owner);
    const memberBot = await runningBot(member);
    const listed = (await call(member, "dozoComputerWall/list")).json as Array<{
      botId: string;
      screen: boolean;
    }>;
    expect(Object.fromEntries(listed.map((tile) => [tile.botId, tile.screen]))).toEqual({
      [ownerBot]: false,
      [memberBot]: true,
    });
    const refused = await call(member, "dozoComputerWall/screen", { botId: ownerBot });
    expect(refused).toEqual({ status: 200, json: { url: null } });
    expect(connectScreen).not.toHaveBeenCalled();
    connectScreen.mockResolvedValueOnce({ url: "http://sandbox.internal/screen" });
    const watched = await call(member, "dozoComputerWall/screen", { botId: memberBot });
    expect((watched.json as { url: string }).url).toContain("/novnc/session/view/");
    expect(connectScreen).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a screen of a bot in a Space the caller is not in", async () => {
    const owner = await person();
    const ownerBot = await runningBot(owner);
    const outsider = await person();
    const screen = await call(outsider, "dozoComputerWall/screen", { botId: ownerBot });
    expect(screen.status).toBe(404);
    const listed = (await call(outsider, "dozoComputerWall/list")).json as unknown[];
    expect(listed).toEqual([]);
  });
});
