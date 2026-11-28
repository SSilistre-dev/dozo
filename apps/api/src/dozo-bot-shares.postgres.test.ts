import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSharedLink } from "./dozo-share-links.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("bot shares (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `bot-share-${randomUUID()}`;
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
    return { status: response!.status, json: body.json as Record<string, unknown> };
  }

  /** A bot of the actor's with one scheduled routine and one that only answers mail. */
  async function bot(actor: Actor) {
    const made = await system.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Gardener",
        description: "Knows plants",
        instructions: "Water the plants.\nMy door code is 1234.",
        color: "#22aa55",
      },
    });
    await system.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, botId: made.id },
    });
    await system.routine.createMany({
      data: [
        {
          spaceId: actor.spaceId,
          botId: made.id,
          userId: actor.userId,
          name: "Morning",
          prompt: "Look at the garden",
          crons: ["0 8 * * *"],
          active: true,
        },
        {
          spaceId: actor.spaceId,
          botId: made.id,
          userId: actor.userId,
          name: "Mail",
          prompt: "Answer",
          crons: [],
          webhookEnabled: true,
        },
      ],
    });
    return made.id;
  }

  async function publish(actor: Actor, botId: string) {
    const preview = await call(actor, "dozoBotShares/preview", { botId, includePicture: false });
    expect(preview.status).toBe(200);
    const made = await call(actor, "dozoBotShares/publish", {
      botId,
      includePicture: false,
      fingerprint: preview.json.fingerprint,
    });
    expect(made.status).toBe(200);
    return new URL(made.json.url as string).pathname.slice("/s/".length);
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
      jobs: { enqueue: async () => undefined },
      // A copy posts its setup checklist and announces its routines in its new chat.
      events: { notify: async () => undefined, append: async () => undefined },
      dataDir: "/tmp/rakazo-bot-shares-test",
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

  it("shows signed out only the snapshot's public part, unchanged by later edits", async () => {
    const ada = await person();
    const botId = await bot(ada);
    const token = await publish(ada, botId);
    await system.bot.update({ where: { id: botId }, data: { name: "Renamed" } });
    expect(await readSharedLink(prisma, token)).toEqual({
      kind: "bot",
      payload: {
        name: "Gardener",
        avatar: { color: "#22aa55", avatarSet: "organic" },
        instructionsExcerpt: "Water the plants.\nMy door code is 1234.",
        routineNames: ["Morning"],
      },
    });
    const status = await call(ada, "dozoBotShares/status", { botId });
    const expiresAt = Date.parse((status.json.link as { expiresAt: string }).expiresAt);
    expect(expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 60_000);
  });

  it("refuses to publish what the owner was not shown", async () => {
    const ada = await person();
    const botId = await bot(ada);
    const preview = await call(ada, "dozoBotShares/preview", { botId, includePicture: false });
    await system.bot.update({ where: { id: botId }, data: { instructions: "Changed" } });
    const made = await call(ada, "dozoBotShares/publish", {
      botId,
      includePicture: false,
      fingerprint: preview.json.fingerprint,
    });
    expect(made.status).toBe(409);
    expect(await system.$queryRaw`SELECT 1 FROM dozo_bot_shares WHERE "botId" = ${botId}`).toEqual(
      [],
    );
  });

  it("lets a signed-in reader copy the bot into their Space, paused and unlinked", async () => {
    const ada = await person();
    const bob = await person();
    const botId = await bot(ada);
    const token = await publish(ada, botId);
    const opened = await call(bob, "dozoBotShares/open", { token });
    expect(opened.status).toBe(200);
    const copy = await call(bob, "dozoBotShares/clone", {
      token,
      fingerprint: opened.json.fingerprint,
      requestId: randomUUID(),
    });
    expect(copy.status).toBe(200);
    const copyId = (copy.json.bot as { id: string }).id;
    const made = await system.bot.findUniqueOrThrow({
      where: { id: copyId },
      include: { routines: true },
    });
    expect(made).toMatchObject({
      spaceId: bob.spaceId,
      userId: bob.userId,
      name: "Gardener",
      instructions: "Water the plants.\nMy door code is 1234.",
      description: "Knows plants",
    });
    expect(made.routines.map((routine) => [routine.name, routine.active])).toEqual([
      ["Morning", false],
    ]);
    const stored = await system.agentImport.findFirstOrThrow({ where: { botId: copyId } });
    expect(JSON.stringify(stored)).not.toContain(botId);
    expect(JSON.stringify(stored)).not.toContain(ada.userId);
  });

  it("closes the link when the owner revokes, republishes, archives or deletes", async () => {
    const ada = await person();
    const botId = await bot(ada);
    const first = await publish(ada, botId);
    const second = await publish(ada, botId);
    expect(await readSharedLink(prisma, first)).toBeNull();
    expect(await readSharedLink(prisma, second)).not.toBeNull();
    expect((await call(ada, "dozoBotShares/revoke", { botId })).status).toBe(200);
    expect(await readSharedLink(prisma, second)).toBeNull();
    expect(await system.$queryRaw`SELECT 1 FROM dozo_bot_shares WHERE "botId" = ${botId}`).toEqual(
      [],
    );
    const third = await publish(ada, botId);
    await system.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
    expect(await readSharedLink(prisma, third)).toBeNull();
    await system.bot.delete({ where: { id: botId } });
    expect(await system.$queryRaw`SELECT 1 FROM dozo_bot_shares WHERE "botId" = ${botId}`).toEqual(
      [],
    );
  });

  it("keeps the snapshot from other members, and another member's bot from being published", async () => {
    const ada = await person();
    const bob = await person();
    const botId = await bot(ada);
    await publish(ada, botId);
    const seen = await runAsTenant(
      bob,
      () => prisma.$queryRaw`SELECT "definition" FROM dozo_bot_shares WHERE "botId" = ${botId}`,
    );
    expect(seen).toEqual([]);
    const refused = await call(bob, "dozoBotShares/preview", { botId, includePicture: false });
    expect(refused.status).toBe(404);
    expect((await call(bob, "dozoBotShares/revoke", { botId })).status).toBe(404);
    const link = await call(bob, "dozoShareLinks/create", {
      kind: "bot",
      targetId: botId,
      days: 1,
    });
    expect(link.status).toBe(404);
  });
});
