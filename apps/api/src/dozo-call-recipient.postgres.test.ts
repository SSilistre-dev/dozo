import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { callClientNonce, callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  createThreadMessageInTransaction,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** A bot's call rings its owner only, so only the owner may answer, decline or end it. */
describePostgres("a bot's call is settled by the person it rings (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `call-${randomUUID()}`;
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

  /** Owner A with a bot in a Space that member C shares. */
  async function sharedSpace() {
    const owner = await person();
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
    if (
      !(await system.spaceMember.findFirst({
        where: { spaceId: owner.spaceId, userId: other.userId },
      }))
    )
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
    const member: Actor = { ...other, spaceId: owner.spaceId };
    const bot = await runAsTenant(owner, () =>
      createRepos(prisma).createBot(owner, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
    const thread = await system.thread.findFirstOrThrow({ where: { botId: bot.id } });
    expect(thread.userId).toBe(owner.userId);
    return { owner, member, botId: bot.id, threadId: thread.id };
  }

  /** The bot's call card as the run leaves it; an answered one also holds what the owner said. */
  async function botCall(
    at: { owner: Actor; botId: string; threadId: string },
    status: "ringing" | "answered",
  ) {
    const callId = randomUUID();
    await system.$transaction(async (tx) => {
      await createThreadMessageInTransaction(tx, {
        threadId: at.threadId,
        botId: at.botId,
        role: "bot",
        blocks: [
          {
            kind: "call_request",
            callId,
            reason: "The report",
            opening: "Hi, it's about the report.",
            status,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ],
        clientNonce: callRequestClientNonce(callId),
        markUnread: true,
      });
      if (status === "answered")
        await createThreadMessageInTransaction(tx, {
          threadId: at.threadId,
          role: "user",
          authorUserId: at.owner.userId,
          blocks: [{ kind: "text", text: "Go on." }],
          clientNonce: callClientNonce(callId),
        });
    });
    return callId;
  }

  async function callStatus(threadId: string, callId: string) {
    const message = await system.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId, clientNonce: callRequestClientNonce(callId) } },
      select: { blocks: true },
    });
    return (message.blocks as { status?: string; durationSeconds?: number }[])[0];
  }

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path.includes("/") ? path : `threads/${path}`}`, {
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
        phoneCallsEnabled: true,
      },
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn() },
      memoryProviders: { resolve: async () => null },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-call-recipient-test",
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

  it("refuses another member's answer and decline as it refuses an unknown call", async () => {
    const at = await sharedSpace();
    const ringing = await botCall(at, "ringing");
    const unknown = randomUUID();
    const answer = (actor: Actor, callId: string) =>
      call(actor, "answerCall", { botId: at.botId, callId });
    const decline = (actor: Actor, callId: string) =>
      call(actor, "declineCall", { botId: at.botId, callId, outcome: "declined" });

    const unknownAnswer = await answer(at.member, unknown);
    expect(unknownAnswer.status).not.toBe(200);
    expect(await answer(at.member, ringing)).toEqual(unknownAnswer);
    expect((await callStatus(at.threadId, ringing))?.status).toBe("ringing");

    const unknownDecline = await decline(at.member, unknown);
    expect(unknownDecline.status).not.toBe(200);
    expect(await decline(at.member, ringing)).toEqual(unknownDecline);
    expect((await callStatus(at.threadId, ringing))?.status).toBe("ringing");
  });

  it("lets the owner answer and decline their own call", async () => {
    const at = await sharedSpace();
    const first = await botCall(at, "ringing");
    const answered = await call(at.owner, "answerCall", { botId: at.botId, callId: first });
    expect(answered).toEqual({
      status: 200,
      json: { opening: "Hi, it's about the report.", reason: "The report" },
    });
    expect((await callStatus(at.threadId, first))?.status).toBe("answered");

    const second = await botCall(at, "ringing");
    const declined = await call(at.owner, "declineCall", {
      botId: at.botId,
      callId: second,
      outcome: "declined",
    });
    expect(declined).toEqual({ status: 200, json: { ok: true } });
    expect((await callStatus(at.threadId, second))?.status).toBe("declined");
  });

  it("ends the owner's answered call only for the owner", async () => {
    const at = await sharedSpace();
    const answered = await botCall(at, "answered");
    const end = (actor: Actor, callId: string) =>
      call(actor, "endCall", { botId: at.botId, callId, durationSeconds: 30 });
    const markers = () =>
      system.message.count({
        where: { threadId: at.threadId, clientNonce: `call:${answered}:marker` },
      });
    const hangUps = () =>
      system.run.count({ where: { threadId: at.threadId, trigger: "call_end" } });

    const unknownEnd = await end(at.member, randomUUID());
    expect(await end(at.member, answered)).toEqual(unknownEnd);
    expect(await callStatus(at.threadId, answered)).not.toHaveProperty("durationSeconds");
    expect(await markers()).toBe(0);
    expect(await hangUps()).toBe(0);

    expect(await end(at.owner, answered)).toEqual({ status: 200, json: { ok: true } });
    expect((await callStatus(at.threadId, answered))?.durationSeconds).toBe(30);
    expect(await markers()).toBe(1);
    expect(await hangUps()).toBe(1);
  });

  it("rings the owner's roster only, never another member's", async () => {
    const at = await sharedSpace();
    const ringing = await botCall(at, "ringing");
    const rung = async (actor: Actor) => {
      const listed = (await call(actor, "bots/list", undefined)).json as {
        id: string;
        incomingCall: { callId: string } | null;
      }[];
      const navigation = (await call(actor, "spaces/list", undefined)).json as {
        current: { bots: { id: string; incomingCall: { callId: string } | null }[] };
      };
      return [listed, navigation.current.bots].map(
        (bots) => bots.find((bot) => bot.id === at.botId)?.incomingCall?.callId ?? null,
      );
    };
    expect(await rung(at.owner)).toEqual([ringing, ringing]);
    expect(await rung(at.member)).toEqual([null, null]);
  });
});
