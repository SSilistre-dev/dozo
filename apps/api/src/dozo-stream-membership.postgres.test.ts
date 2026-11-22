import { randomUUID } from "node:crypto";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessageInTransaction,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dozoRouterConnector } from "./dozo-bot-api.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { SESSION_RECHECK_MS } from "./routes/shared.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** How soon after the next message a removed member's stream must have ended. */
const ENDS_WITHIN_MS = 3_000;

type Stream = { text: string; ended: boolean; unauthorized: boolean; close: () => void };
type Follow = (actor: Actor, input: { botId: string; cursor: number }) => Promise<Stream>;

/** A removed member's open chat stream, through the app's own routes. */
describePostgres("a chat stream after its member is removed (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let connect: ReturnType<typeof dozoRouterConnector>;
  const organizations: string[] = [];
  const users: string[] = [];
  const streams: Stream[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", defaultModelProvider: "openrouter", defaultModelId: "fake" },
      update: {},
    });
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
    } as unknown as RouterDeps;
    const router = createRouter(deps);
    connect = dozoRouterConnector(router);
    handler = new RPCHandler(router, {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    for (const stream of streams) stream.close();
    if (prisma) {
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function person(name: string) {
    const id = randomUUID();
    users.push(id);
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    return id;
  }

  /** An owner's Space with a second member in it, and a bot with its chat. */
  async function sharedSpace() {
    const ownerId = await person("Ada");
    const memberId = await person("Grace");
    const spaceId = randomUUID();
    organizations.push(spaceId);
    const createdAt = new Date();
    await system.organization.create({
      data: { id: spaceId, name: "Team", slug: spaceId, createdAt },
    });
    await system.space.create({
      data: { id: spaceId, organizationId: spaceId, name: "Team", isDefault: true },
    });
    // The database adds each organization member to its default Space.
    await system.member.create({
      data: { id: ownerId, organizationId: spaceId, userId: ownerId, role: "owner", createdAt },
    });
    await system.member.create({
      data: { id: memberId, organizationId: spaceId, userId: memberId, role: "member", createdAt },
    });
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId: ownerId,
        scopeKey: spaceId,
        homeKey: spaceId,
        kind: "fake",
        state: "running",
      },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId: ownerId, name: "Chef", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({
      data: { spaceId, userId: ownerId, botId: bot.id },
    });
    const actor = (userId: string): Actor => ({
      spaceId,
      userId,
      email: `${userId}@example.test`,
      isDeploymentOwner: false,
    });
    return { spaceId, owner: actor(ownerId), member: actor(memberId), botId: bot.id, thread };
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
    return response!.status;
  }

  /**
   * As the app's session re-check, and the Bot API's token re-check (a member's tokens go with
   * their membership): the person must still be in the stream's Space.
   */
  async function stillAuthorized(actor: Actor) {
    return Boolean(
      await system.spaceMember.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true },
      }),
    );
  }

  /** Follows a chat as the app does, collecting the raw frames as they arrive. */
  const followInApp: Follow = async (actor, input) => {
    const controller = new AbortController();
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
        signal: controller.signal,
      }),
      {
        prefix: "/rpc",
        context: {
          actor,
          signal: controller.signal,
          stillAuthorized: () => stillAuthorized(actor),
        },
      },
    );
    expect(response?.status).toBe(200);
    const stream: Stream = {
      text: "",
      ended: false,
      unauthorized: false,
      close: () => controller.abort(),
    };
    streams.push(stream);
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.text += decoder.decode(value, { stream: true });
        }
      } finally {
        stream.unauthorized = /event: error[\s\S]*UNAUTHORIZED/.test(stream.text);
        stream.ended = true;
      }
    })();
    return stream;
  };

  /** Follows a chat as the Bot API and MCP do: the app's own procedure, called in process. */
  const followInProcess: Follow = async (actor, input) => {
    const controller = new AbortController();
    const context = {
      actor,
      signal: controller.signal,
      stillAuthorized: () => stillAuthorized(actor),
    };
    const events = await connect(context).threads.subscribe(input, { signal: controller.signal });
    const stream: Stream = {
      text: "",
      ended: false,
      unauthorized: false,
      close: () => controller.abort(),
    };
    streams.push(stream);
    void (async () => {
      try {
        for await (const event of events) stream.text += `${JSON.stringify(event)}\n`;
      } catch (error) {
        stream.unauthorized = error instanceof ORPCError && error.code === "UNAUTHORIZED";
      } finally {
        stream.ended = true;
      }
    })();
    return stream;
  };

  /** A bot reply in the chat, as a run leaves it. */
  async function botSays(spaceId: string, threadId: string, botId: string, text: string) {
    await system.$transaction(async (tx) => {
      const blocks = [{ kind: "text" as const, text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        botId,
        blocks,
      });
      await appendEventInTransaction(tx, {
        spaceId,
        threadId,
        botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
    });
  }

  it.each([
    ["the app's stream", () => followInApp],
    ["the Bot API's and MCP's in-process stream", () => followInProcess],
  ])(
    "ends a removed member's stream before anything written after the removal reaches it: %s",
    async (_, which) => {
      const follow = which();
      const { spaceId, owner, member, botId, thread } = await sharedSpace();
      const before = `before-removal-${randomUUID()}`;
      const after = `after-removal-${randomUUID()}`;
      const openedAt = Date.now();
      const removed = await follow(member, { botId, cursor: -1 });
      const stays = await follow(owner, { botId, cursor: -1 });

      // While a member, they see the chat.
      await botSays(spaceId, thread.id, botId, before);
      await vi.waitFor(() => expect(removed.text).toContain(before), { timeout: 5_000 });

      expect(await call(owner, "spaces/members/remove", { spaceId, userId: member.userId })).toBe(
        200,
      );
      expect(
        await call(owner, "threads/send", { botId, text: after, clientNonce: randomUUID() }),
      ).toBe(200);
      const writtenAt = Date.now();
      // Inside the session re-check window, so only the membership check can end the stream now.
      expect(writtenAt - openedAt).toBeLessThan(SESSION_RECHECK_MS);

      // The owner's stream gets the message, so it was there to be delivered.
      await vi.waitFor(() => expect(stays.text).toContain(after), { timeout: 5_000 });
      await vi.waitFor(() => expect(removed.ended || removed.text.includes(after)).toBe(true), {
        timeout: ENDS_WITHIN_MS,
      });
      expect(removed.text, "the removed member's stream got the message").not.toContain(after);
      expect(removed.ended).toBe(true);
      expect(Date.now() - writtenAt).toBeLessThan(ENDS_WITHIN_MS);
      expect(removed.unauthorized).toBe(true);
      expect(stays.ended).toBe(false);
    },
  );
});
