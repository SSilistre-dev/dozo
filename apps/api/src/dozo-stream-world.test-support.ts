import { randomUUID } from "node:crypto";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { InMemoryRealtimeFanout } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  asSystem,
  createBoardEvents,
  createDb,
  createDozoAccessToken,
  createThreadEvents,
  createThreadMessageInTransaction,
  followRosterChanges,
  loadRosterScope,
} from "@rakazo/db";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { dozoRouterConnector } from "./dozo-bot-api.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

/** How soon after the next write an ended caller's stream must have ended. */
export const ENDS_WITHIN_MS = 3_000;

/**
 * A step that has to fit inside a window the server works to (the session re-check, how soon an
 * ended stream stops): fails when `windowMs` has passed since `since`. A named check, not a clock
 * read inside `expect`, because a real server and a real database cannot run on fake timers.
 */
export function assertStillWithin(since: number, windowMs: number) {
  const elapsed = Date.now() - since;
  if (elapsed >= windowMs) {
    throw new Error(`${elapsed} ms since the start, past the ${windowMs} ms window`);
  }
}

/** An open stream as its client sees it, and how its caller signs out of it. */
export type Stream = {
  text: string;
  ended: boolean;
  unauthorized: boolean;
  /** The app's: the session it was opened with. */
  sessionId?: string;
  /** The Bot API's and MCP's: the access token it was opened with. */
  tokenId?: string;
  close: () => void;
  signOut: () => Promise<void>;
};
export type Follow = (actor: Actor, input: { botId: string; cursor: number }) => Promise<Stream>;
export type SharedSpace = Awaited<ReturnType<StreamWorld["sharedSpace"]>>;
export type Ending = (space: SharedSpace, stream: Stream) => Promise<void>;
export type StreamWorld = ReturnType<typeof streamWorld>;

/**
 * The app's router on a real database, with open chat, notification, call and board streams
 * through its own routes. Chats are followed as the database alone follows them; the signals
 * (alerts, roster, Space changes, calls, board changes) go through one in-memory fanout, and
 * roster signals are not spaced, so a test sees the next one at once. Call inside a `describe`.
 */
export function streamWorld() {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let connect: ReturnType<typeof dozoRouterConnector>;
  let deps: RouterDeps;
  const realtime = new InMemoryRealtimeFanout();
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
    const signals = createThreadEvents(prisma, realtime);
    deps = {
      prisma,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://app.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        phoneCallsEnabled: true,
        deploymentLabs: ["board"],
      },
      events: {
        ...createThreadEvents(prisma),
        publishChatAlert: signals.publishChatAlert,
        followChatAlerts: signals.followChatAlerts,
        notifyIncomingCalls: signals.notifyIncomingCalls,
        followIncomingCalls: signals.followIncomingCalls,
        publishRosterChange: signals.publishRosterChange,
        followRosterChanges: (userId: string, signal?: AbortSignal) =>
          followRosterChanges(realtime, userId, () => loadRosterScope(prisma, userId), signal, 0),
        publishSpaceChange: signals.publishSpaceChange,
        followSpaceChanges: signals.followSpaceChanges,
      },
      boardEvents: createBoardEvents(realtime),
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
   * their membership): the person must still be in the stream's Space. It asks nothing about the
   * session or the account, and only every few seconds, so whatever ends a stream sooner is the
   * stream's own check.
   */
  async function stillAuthorized(actor: Actor) {
    return Boolean(
      await system.spaceMember.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true },
      }),
    );
  }

  /** A signed-in session of the person's, as the auth library keeps one. */
  async function signIn(actor: Actor) {
    const id = randomUUID();
    await system.session.create({
      data: {
        id,
        token: randomUUID(),
        userId: actor.userId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    return id;
  }

  /**
   * Opens an app stream at `path`, collecting the raw frames as they arrive, with a fresh session
   * unless it is given the one to open it with.
   */
  async function openInApp(
    actor: Actor,
    path: string,
    input: unknown,
    session?: string,
  ): Promise<Stream> {
    const controller = new AbortController();
    const sessionId = session ?? (await signIn(actor));
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
        signal: controller.signal,
      }),
      {
        prefix: "/rpc",
        context: {
          actor,
          sessionId,
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
      sessionId,
      close: () => controller.abort(),
      // As signing out, "sign out other sessions", a password change or an operator does.
      signOut: async () => {
        await system.session.delete({ where: { id: sessionId } });
      },
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
  }

  /** Follows a chat as the app does. */
  const followInApp: Follow = (actor, input) => openInApp(actor, "threads/subscribe", input);

  /** Follows a chat as the Bot API and MCP do: the app's own procedure, called in process. */
  const followInProcess: Follow = async (actor, input) => {
    const controller = new AbortController();
    const token = await createDozoAccessToken(system, actor, {
      name: "Script",
      botId: null,
      expiresAt: null,
    });
    const context = {
      actor,
      dozoAccessTokenId: token!.row.id,
      signal: controller.signal,
      stillAuthorized: () => stillAuthorized(actor),
    };
    const events = await connect(context).threads.subscribe(input, { signal: controller.signal });
    const stream: Stream = {
      text: "",
      ended: false,
      unauthorized: false,
      tokenId: token!.row.id,
      close: () => controller.abort(),
      // "Sign out everywhere", which revokes every token the account made before it.
      signOut: async () => {
        await system.securityEvent.create({
          data: {
            type: "auth.session.revoked",
            userId: actor.userId,
            metadata: { via: "/revoke-sessions" },
          },
        });
      },
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

  /** The ways a caller stops being allowed, each as the product does it. */
  const endings: Array<[string, Ending]> = [
    [
      "removed from the Space",
      async ({ spaceId, owner, member }) => {
        expect(await call(owner, "spaces/members/remove", { spaceId, userId: member.userId })).toBe(
          200,
        );
      },
    ],
    ["signed out", async (_, stream) => stream.signOut()],
    [
      "deactivated",
      async ({ member }) => {
        await system.user.update({
          where: { id: member.userId },
          data: { deactivatedAt: new Date() },
        });
      },
    ],
  ];

  const followers: Array<[string, () => Follow]> = [
    ["the app's stream", () => followInApp],
    ["the Bot API's and MCP's in-process stream", () => followInProcess],
  ];

  return {
    realtime,
    get system() {
      return system;
    },
    get deps() {
      return deps;
    },
    sharedSpace,
    call,
    signIn,
    openInApp,
    followInApp,
    followInProcess,
    botSays,
    endings,
    followers,
  };
}
