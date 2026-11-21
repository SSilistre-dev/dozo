import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import {
  DOZO_BOT_CHATS_LIMIT_CODE,
  DOZO_BOT_CHATS_MAX,
  DOZO_BOT_CHATS_TOTAL_LIMIT_CODE,
  DOZO_BOT_CHATS_TOTAL_MAX,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, createThreadEvents, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { resolveThreadTarget } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

type Chat = {
  id: string;
  botId: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
};

describePostgres("a bot's extra chats (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];
  const publishRosterChange = vi.fn(async () => undefined);

  async function person(): Promise<Actor> {
    const id = `chats-${randomUUID()}`;
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

  async function bot(actor: Actor) {
    const created = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Chef",
        description: "",
        instructions: "Plan meals.",
        notifyOnFinish: false,
      }),
    );
    const main = await system.thread.findFirstOrThrow({ where: { botId: created.id } });
    return { botId: created.id, mainThreadId: main.id };
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

  type ChatOp = "list" | "create" | "rename" | "archive";
  const chatCall = (actor: Actor, op: ChatOp, input: unknown) =>
    call(actor, `dozoChats/${op}`, input);

  const create = async (actor: Actor, botId: string, name = "Garden") => {
    const answer = await chatCall(actor, "create", { botId, name });
    return { ...answer, chat: answer.json.chat as Chat };
  };
  const list = async (actor: Actor, botId: string, includeArchived?: boolean) => {
    const answer = await chatCall(actor, "list", { botId, includeArchived });
    expect(answer.status).toBe(200);
    return answer.json.chats as Chat[];
  };
  const archive = (actor: Actor, chatId: string, archived = true) =>
    chatCall(actor, "archive", { chatId, archived });

  /** Within a minute of now: a time read in the session's zone as if it were UTC is hours off. */
  const recent = (iso: string | null) =>
    expect(Math.abs(Date.parse(iso ?? "") - Date.now())).toBeLessThan(60_000);

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
      events: { ...createThreadEvents(prisma), publishRosterChange },
      jobs: { enqueue: vi.fn() },
      // No Space memory learns from turns, so a revision can take one back.
      memoryProviders: { resolve: async () => null },
      secrets: { remove: vi.fn().mockResolvedValue(undefined) },
      dataDir: "/tmp/rakazo-bot-chats-test",
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

  it("creates, lists, renames and archives extra chats, with times right in any zone", async () => {
    const me = await person();
    const { botId } = await bot(me);
    expect(await list(me, botId)).toEqual([]);

    const first = await create(me, botId, "  Garden  ");
    expect(first.status).toBe(200);
    expect(first.chat).toMatchObject({ botId, name: "Garden", archivedAt: null });
    recent(first.chat.createdAt);
    expect(publishRosterChange).toHaveBeenLastCalledWith({ spaceIds: [me.spaceId] });
    const second = (await create(me, botId, "Taxes")).chat;
    expect((await list(me, botId)).map((chat) => chat.name)).toEqual(["Garden", "Taxes"]);

    const renamed = await chatCall(me, "rename", { chatId: second.id, name: "Taxes 2026" });
    expect(renamed.status).toBe(200);
    expect((renamed.json.chat as Chat).name).toBe("Taxes 2026");

    const archived = await archive(me, first.chat.id);
    expect(archived.status).toBe(200);
    const archivedAt = (archived.json.chat as Chat).archivedAt;
    recent(archivedAt);
    // Doing it again changes nothing, the time included.
    expect(((await archive(me, first.chat.id)).json.chat as Chat).archivedAt).toBe(archivedAt);
    expect((await list(me, botId)).map((chat) => chat.id)).toEqual([second.id]);
    expect((await list(me, botId, true)).map((chat) => chat.id)).toEqual([
      first.chat.id,
      second.id,
    ]);
    expect(((await archive(me, first.chat.id, false)).json.chat as Chat).archivedAt).toBeNull();
    expect(await list(me, botId)).toHaveLength(2);
  });

  it("leaves the bot's main chat exactly as before, for the previous release's queries too", async () => {
    const me = await person();
    const { botId, mainThreadId } = await bot(me);
    const headBefore = await call(me, "threads/head", { botId });
    const getBefore = await call(me, "threads/get", { botId });
    const extra = (await create(me, botId)).chat;
    await create(me, botId, "Second");

    // The extra chats are threads of the Space with no bot on them, so a bot's chat is still one.
    const threads = await system.thread.findMany({ where: { botId } });
    expect(threads.map((thread) => thread.id)).toEqual([mainThreadId]);
    expect((await system.thread.findUnique({ where: { botId } }))?.id).toBe(mainThreadId);
    expect((await system.thread.findFirst({ where: { botId } }))?.id).toBe(mainThreadId);
    const extraThread = await system.thread.findUniqueOrThrow({ where: { id: extra.id } });
    expect(extraThread).toMatchObject({
      spaceId: me.spaceId,
      botId: null,
      groupId: null,
      helperBotId: null,
      externalConversationId: null,
    });
    const found = await runAsTenant(me, () => createRepos(prisma).getBot(me, botId));
    expect(found.thread?.id).toBe(mainThreadId);
    const target = await runAsTenant(me, () => resolveThreadTarget(prisma, me, { botId }));
    expect(target.threadId).toBe(mainThreadId);

    expect(await call(me, "threads/head", { botId })).toEqual(headBefore);
    expect(await call(me, "threads/get", { botId })).toEqual(getBefore);
  });

  it("lets the routes that take a chat id reach an extra chat for its Space only", async () => {
    const me = await person();
    const stranger = await person();
    const { botId } = await bot(me);
    const extra = (await create(me, botId)).chat;
    for (const [path, input] of [
      ["dozoMessages/pins", { threadId: extra.id }],
      ["dozoMessages/revisable", { threadId: extra.id }],
    ] as const) {
      expect((await call(me, path, input)).status, path).toBe(200);
      expect((await call(stranger, path, input)).status, path).toBe(404);
    }
  });

  it("keeps chats to the bot's Space", async () => {
    const me = await person();
    const stranger = await person();
    const { botId } = await bot(me);
    const extra = (await create(me, botId)).chat;
    expect((await chatCall(stranger, "list", { botId })).status).toBe(404);
    expect((await create(stranger, botId)).status).toBe(404);
    expect((await chatCall(stranger, "rename", { chatId: extra.id, name: "Mine" })).status).toBe(
      404,
    );
    expect((await archive(stranger, extra.id)).status).toBe(404);
    // Row security holds it too, without the route's checks.
    const seen = await runAsTenant(
      stranger,
      () =>
        prisma.$queryRaw<unknown[]>`SELECT 1 FROM dozo_bot_chats WHERE "threadId" = ${extra.id}`,
    );
    expect(seen).toEqual([]);
    expect((await list(me, botId)).map((chat) => chat.name)).toEqual(["Garden"]);
  });

  it("refuses an empty, overlong or multi-line name", async () => {
    const me = await person();
    const { botId } = await bot(me);
    for (const name of ["   ", "x".repeat(81), "one\ntwo"]) {
      expect((await create(me, botId, name)).status, JSON.stringify(name)).toBe(400);
    }
    expect((await create(me, botId, "x".repeat(80))).status).toBe(200);
  });

  it("holds a bot's open chats under the limit, under concurrent creates too", async () => {
    const me = await person();
    const { botId } = await bot(me);
    for (let i = 0; i < DOZO_BOT_CHATS_MAX - 2; i += 1) await create(me, botId, `Chat ${i}`);
    const racing = await Promise.all([1, 2, 3, 4].map((i) => create(me, botId, `Race ${i}`)));
    expect(racing.map((answer) => answer.status).sort()).toEqual([200, 200, 409, 409]);
    const refused = racing.find((answer) => answer.status === 409)!;
    expect(refused.json).toMatchObject({ code: DOZO_BOT_CHATS_LIMIT_CODE });
    expect(await list(me, botId)).toHaveLength(DOZO_BOT_CHATS_MAX);

    const [oldest] = await list(me, botId);
    expect((await archive(me, oldest!.id)).status).toBe(200);
    expect((await create(me, botId, "One more")).status).toBe(200);
    // Bringing one back would go past the limit.
    expect((await archive(me, oldest!.id, false)).status).toBe(409);
  });

  it("lets an archived bot's chats be listed but not changed", async () => {
    const me = await person();
    const { botId } = await bot(me);
    const extra = (await create(me, botId)).chat;
    await system.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
    expect((await list(me, botId)).map((chat) => chat.id)).toEqual([extra.id]);
    expect((await create(me, botId)).status).toBe(404);
    expect((await archive(me, extra.id)).status).toBe(404);
  });

  it("still gives every thread one owner: a bot chat's row counts, nothing else is let through", async () => {
    const me = await person();
    const { botId, mainThreadId } = await bot(me);
    const ownerless = system.thread.create({ data: { spaceId: me.spaceId, userId: me.userId } });
    await expect(ownerless).rejects.toThrow(/threads_owner_chk/);
    const twoOwners = system.thread.create({
      data: { spaceId: me.spaceId, userId: me.userId, botId, helperBotId: botId },
    });
    await expect(twoOwners).rejects.toThrow(/threads_owner_chk/);
    // Giving up an owner is checked too: the main chat cannot lose its bot.
    const orphaned = system.thread.update({ where: { id: mainThreadId }, data: { botId: null } });
    await expect(orphaned).rejects.toThrow(/threads_owner_chk/);
    expect((await create(me, botId)).status).toBe(200);
  });

  it("deletes a deleted bot's extra chats with it, and a deleted chat's row with it", async () => {
    const me = await person();
    const { botId } = await bot(me);
    const extra = (await create(me, botId)).chat;
    const other = (await create(me, botId, "Other")).chat;
    await system.thread.delete({ where: { id: other.id } });
    expect((await list(me, botId, true)).map((chat) => chat.id)).toEqual([extra.id]);
    await system.bot.delete({ where: { id: botId } });
    expect(await system.thread.findUnique({ where: { id: extra.id } })).toBeNull();
    const rows = await system.$queryRaw<unknown[]>`
      SELECT 1 FROM dozo_bot_chats WHERE "botId" = ${botId}`;
    expect(rows).toEqual([]);
  });
  it("caps a bot's chats in all, so creating and archiving cannot grow them forever", async () => {
    const me = await person();
    const { botId } = await bot(me);
    for (let i = 0; i < DOZO_BOT_CHATS_TOTAL_MAX; i += 1) {
      const made = await create(me, botId, `Chat ${i}`);
      expect(made.status).toBe(200);
      expect((await archive(me, made.chat.id)).status).toBe(200);
    }
    const refused = await create(me, botId, "One too many");
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: DOZO_BOT_CHATS_TOTAL_LIMIT_CODE });
    // Bringing one back adds no row: only the open limit applies.
    const [oldest] = await list(me, botId, true);
    expect((await archive(me, oldest!.id, false)).status).toBe(200);
  });

  it("lets one of a create and a bring-back racing for the last open place through", async () => {
    const me = await person();
    const { botId } = await bot(me);
    const archived = (await create(me, botId, "Archived")).chat;
    await archive(me, archived.id);
    for (let i = 0; i < DOZO_BOT_CHATS_MAX - 1; i += 1) await create(me, botId, `Chat ${i}`);
    const [made, back] = await Promise.all([
      create(me, botId, "Racing"),
      archive(me, archived.id, false),
    ]);
    expect([made.status, back.status].sort()).toEqual([200, 409]);
    expect(await list(me, botId)).toHaveLength(DOZO_BOT_CHATS_MAX);
  });

  it("takes the chat's thread with its row when the row alone is deleted", async () => {
    const me = await person();
    const { botId } = await bot(me);
    const extra = (await create(me, botId)).chat;
    await system.$executeRaw`DELETE FROM dozo_bot_chats WHERE "threadId" = ${extra.id}`;
    expect(await system.thread.findUnique({ where: { id: extra.id } })).toBeNull();
  });

  it("keeps a chat's row, its bot and its thread in one Space, and the thread without an owner", async () => {
    const me = await person();
    const other = await person();
    const { botId, mainThreadId } = await bot(me);
    const foreign = await bot(other);
    const extra = (await create(me, botId)).chat;
    const insert = (threadId: string, rowBotId: string, spaceId: string) =>
      system.$executeRaw`
        INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name)
        VALUES (${threadId}, ${rowBotId}, ${spaceId}, 'x')`;
    const ownerless = (spaceId: string, userId: string) =>
      system.$transaction(async (tx) => {
        const thread = await tx.thread.create({ data: { spaceId, userId }, select: { id: true } });
        return thread.id;
      });
    // Another Space's bot, a thread that already has an owner, a thread of another Space.
    await expect(
      system.$transaction(async (tx) => {
        const thread = await tx.thread.create({
          data: { spaceId: me.spaceId, userId: me.userId },
          select: { id: true },
        });
        await tx.$executeRaw`
          INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name)
          VALUES (${thread.id}, ${foreign.botId}, ${me.spaceId}, 'x')`;
      }),
    ).rejects.toThrow(/share its bot/);
    await expect(insert(mainThreadId, botId, me.spaceId)).rejects.toThrow(/share its bot/);
    await expect(ownerless(other.spaceId, other.userId)).rejects.toThrow(/threads_owner_chk/);
    await expect(
      system.$executeRaw`UPDATE dozo_bot_chats SET "spaceId" = ${other.spaceId} WHERE "threadId" = ${extra.id}`,
    ).rejects.toThrow(/share its bot|violates/);
    // A bot chat's thread cannot take an owner.
    await expect(
      system.thread.update({ where: { id: extra.id }, data: { helperBotId: botId } }),
    ).rejects.toThrow(/threads_owner_chk/);
    // The name has its limit in the table too, not only in the contract.
    await expect(
      system.$executeRaw`UPDATE dozo_bot_chats SET name = ${"x".repeat(81)} WHERE "threadId" = ${extra.id}`,
    ).rejects.toThrow(/check/);
  });
});
