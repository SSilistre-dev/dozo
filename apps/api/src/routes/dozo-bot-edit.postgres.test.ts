import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createGroupRepos,
  createRepos,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";
import type { WebhookDeps } from "../webhook.js";
import { mountWebhookHttpRoutes, WEBHOOK_SECRET_KIND } from "../webhook.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const WEBHOOK_TOKEN = "bot-edit-webhook-token";

describePostgres("who changes a shared bot's run settings (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];
  const organizations: string[] = [];

  async function person(name: string): Promise<Actor> {
    const id = `bot-edit-${name}-${randomUUID()}`;
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  /** A Space of `owner`'s organization that `member` joined as a plain member. */
  async function sharedSpace() {
    const owner = await person("owner");
    const member = await person("member");
    const spaceId = randomUUID();
    const organizationId = owner.spaceId;
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Home", createdByUserId: owner.userId },
    });
    const createdAt = new Date();
    await system.member.create({
      data: { id: randomUUID(), organizationId, userId: member.userId, role: "member", createdAt },
    });
    for (const [userId, role] of [
      [owner.userId, "owner"],
      [member.userId, "member"],
    ] as const)
      await system.spaceMember.create({
        data: { id: randomUUID(), spaceId, organizationId, userId, role, createdAt },
      });
    return { owner: { ...owner, spaceId }, member: { ...member, spaceId } };
  }

  const newBot = (actor: Actor, name: string) =>
    runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name,
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );

  const newGroup = async (actor: Actor) => {
    const bots = [await newBot(actor, "Chef"), await newBot(actor, "Planner")];
    return runAsTenant(actor, () =>
      createGroupRepos(prisma).createGroup(actor, {
        name: "Kitchen",
        botIds: bots.map((bot) => bot.id),
      }),
    );
  };

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

  const instructionsOf = async (botId: string) =>
    (await system.bot.findUniqueOrThrow({ where: { id: botId } })).instructions;

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
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      artifacts: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-bot-edit-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("runs a bot's webhook delivery as its creator", async () => {
    const { owner } = await sharedSpace();
    const chef = await newBot(owner, "Chef");
    const webhookSecret = await system.secret.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        kind: WEBHOOK_SECRET_KIND,
        ciphertext: "sealed",
      },
    });
    await system.bot.update({
      where: { id: chef.id },
      data: { webhookSecretId: webhookSecret.id },
    });
    await system.routine.create({
      data: {
        botId: chef.id,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Order",
        prompt: "Order groceries",
        crons: [],
        active: true,
        webhookEnabled: true,
      },
    });
    const sendUserMessage = vi.fn(async () => ({ messageId: "message", runId: null, seq: 1 }));
    const app = new Hono();
    app.use("/api/v1/bots/*", (_c, next) => runAsSystem("bot webhook", next));
    mountWebhookHttpRoutes(app, {
      prisma,
      secrets: { load: async () => WEBHOOK_TOKEN } as unknown as SecretStore,
      events: { sendUserMessage } as unknown as WebhookDeps["events"],
      jobs: { enqueue: vi.fn() },
    });

    const response = await app.request(`/api/v1/bots/${chef.id}/webhook`, {
      method: "POST",
      headers: { authorization: `Bearer ${WEBHOOK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "ping" }),
    });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botId: chef.id, userId: owner.userId }),
    );
  });

  it.each([
    ["instructions", { instructions: "Do something else." }],
    ["dailyCheckIns", { dailyCheckIns: true }],
    ["fleetManagement", { fleetManagement: true }],
    ["crossSpaceCommunication", { crossSpaceCommunication: true }],
    ["teamChatAmbientEnabled", { teamChatAmbientEnabled: false }],
    ["teamChatRules", { teamChatRules: "Answer everything." }],
    ["memoryScope", { memoryScope: "shared" }],
    ["disabledBuiltinTools", { disabledBuiltinTools: [] }],
  ])("lets only the creator or the space owner change %s", async (_field, patch) => {
    const { owner, member } = await sharedSpace();
    const ownersBot = await newBot(owner, "Chef");
    const membersBot = await newBot(member, "Scout");
    await system.bot.updateMany({
      where: { id: { in: [ownersBot.id, membersBot.id] } },
      data: {
        dailyCheckIns: false,
        fleetManagement: false,
        crossSpaceCommunication: false,
        teamChatAmbientEnabled: true,
        memoryScope: "isolated",
        disabledBuiltinTools: ["web_search"],
      },
    });

    const refused = await call(member, "bots/update", { botId: ownersBot.id, ...patch });
    expect(refused.status).toBe(403);
    expect(await instructionsOf(ownersBot.id)).toBe("Plan meals.");

    expect((await call(owner, "bots/update", { botId: ownersBot.id, ...patch })).status).toBe(200);
    expect((await call(member, "bots/update", { botId: membersBot.id, ...patch })).status).toBe(
      200,
    );
    expect((await call(owner, "bots/update", { botId: membersBot.id, ...patch })).status).toBe(200);
  });

  it("lets any member rename, recolor and organize a shared bot, and resend its settings unchanged", async () => {
    const { owner, member } = await sharedSpace();
    const chef = await newBot(owner, "Chef");

    const saved = await call(member, "bots/update", {
      botId: chef.id,
      name: "Head chef",
      description: "Cooks",
      color: "#000000",
      pinned: true,
      notifyOnFinish: true,
      instructions: "Plan meals.",
    });

    expect(saved.status).toBe(200);
    expect(await system.bot.findUniqueOrThrow({ where: { id: chef.id } })).toMatchObject({
      name: "Head chef",
      instructions: "Plan meals.",
    });
  });

  it("lets only the creator or the space owner restore earlier instructions", async () => {
    const { owner, member } = await sharedSpace();
    const chef = await newBot(owner, "Chef");
    expect(
      (await call(owner, "bots/update", { botId: chef.id, instructions: "Cook dinner." })).status,
    ).toBe(200);
    const { instructionHistory } = await system.bot.findUniqueOrThrow({ where: { id: chef.id } });
    const [version] = instructionHistory as Array<{ id: string; instructions: string }>;
    expect(version?.instructions).toBe("Plan meals.");

    const restore = {
      botId: chef.id,
      versionId: version!.id,
      expectedInstructions: "Cook dinner.",
    };
    expect((await call(member, "bots/restoreInstructions", restore)).status).toBe(403);
    expect(await instructionsOf(chef.id)).toBe("Cook dinner.");
    expect((await call(owner, "bots/restoreInstructions", restore)).status).toBe(200);
    expect(await instructionsOf(chef.id)).toBe("Plan meals.");
  });

  it("lets only a bot's creator or the space owner switch its computer, which moves its files", async () => {
    const { owner, member } = await sharedSpace();
    const ownersBot = await newBot(owner, "Keeper");
    const membersBot = await newBot(member, "Scout");
    const scopeOf = async (botId: string) =>
      (
        await system.bot.findUniqueOrThrow({
          where: { id: botId },
          select: { computer: { select: { scope: true } } },
        })
      ).computer?.scope;
    const own = { mode: "dedicated" };

    const refused = await call(member, "bots/setComputer", { botId: ownersBot.id, ...own });
    expect(refused.status).toBe(403);
    expect(await scopeOf(ownersBot.id)).toBe("team");
    expect((await call(member, "bots/setComputer", { botId: membersBot.id, ...own })).status).toBe(
      200,
    );
    expect(await scopeOf(membersBot.id)).toBe("dedicated");
    expect(
      (await call(owner, "bots/setComputer", { botId: membersBot.id, mode: "team" })).status,
    ).toBe(200);
    expect(await scopeOf(membersBot.id)).toBe("team");
    expect((await call(owner, "bots/setComputer", { botId: ownersBot.id, ...own })).status).toBe(
      200,
    );
    // Each switch held its lease, and nothing was left for the sweep.
    const rows = await system.$queryRaw<unknown[]>`
      SELECT 1 FROM "leases"
      WHERE "key" IN (${`dozo-computer-switch:${ownersBot.id}`}, ${`dozo-computer-switch-due:${ownersBot.id}`},
        ${`dozo-computer-switch:${membersBot.id}`}, ${`dozo-computer-switch-due:${membersBot.id}`})`;
    expect(rows).toEqual([]);
  });

  it("lets any member archive a group but only its creator or the space owner remove it", async () => {
    const { owner, member } = await sharedSpace();
    const ownersGroup = await newGroup(owner);
    const membersGroup = await newGroup(member);
    const exists = async (id: string) =>
      Boolean(await system.chatGroup.findUnique({ where: { id } }));

    expect((await call(member, "groups/remove", { groupId: ownersGroup.id })).status).toBe(403);
    expect(await exists(ownersGroup.id)).toBe(true);
    expect((await call(member, "groups/archive", { groupId: ownersGroup.id })).status).toBe(200);

    await call(owner, "groups/remove", { groupId: membersGroup.id });
    expect(await exists(membersGroup.id)).toBe(false);
    await call(owner, "groups/remove", { groupId: ownersGroup.id });
    expect(await exists(ownersGroup.id)).toBe(false);
  });
});
