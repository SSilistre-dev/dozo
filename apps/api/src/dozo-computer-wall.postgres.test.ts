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
      data: { state: "running", providerRef: `ref-${bot.id}`, runningSince: new Date() },
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

  it("never shows a member another person's computer, nor hands out its screen", async () => {
    const owner = await person();
    const ownerBot = await runningBot(owner);
    const other = await person();
    const otherBot = await runningBot(other);
    const listed = await call(other, "dozoComputerWall/list");
    expect((listed.json as Array<{ botId: string }>).map((tile) => tile.botId)).toEqual([
      otherBot,
    ]);
    const screen = await call(other, "computer/screenUrl", { botId: ownerBot, preview: true });
    expect(screen.status).toBe(404);
    expect(JSON.stringify(screen.json)).not.toContain("novnc");
    expect(connectScreen).not.toHaveBeenCalled();
  });
});
