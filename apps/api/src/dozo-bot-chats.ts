import type {
  Actor,
  DozoBotChat,
  DozoBotChatArchiveInput,
  DozoBotChatCreateInput,
  DozoBotChatRenameInput,
  DozoBotChatsListInput,
} from "@rakazo/contracts";
import {
  DOZO_BOT_CHATS_LIMIT_CODE,
  DOZO_BOT_CHATS_MAX,
  DOZO_BOT_CHATS_TOTAL_LIMIT_CODE,
  DOZO_BOT_CHATS_TOTAL_MAX,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";
import { resolveThreadTarget } from "./thread-target.js";

type Db = Pick<PrismaClient, "$queryRaw">;
type Tx = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "thread">;

type ChatRow = {
  threadId: string;
  botId: string;
  name: string;
  createdAt: Date;
  archivedAt: Date | null;
  unread: boolean | null;
  snoozedUntil: Date | null;
};

/** The bot holds the most open extra chats, or the most it can ever hold, archived ones included. */
export class DozoBotChatsLimitError extends ClientError {
  constructor(total = false) {
    super(
      "CONFLICT",
      total
        ? `A bot holds at most ${DOZO_BOT_CHATS_TOTAL_MAX} chats, archived ones included.`
        : `A bot holds at most ${DOZO_BOT_CHATS_MAX} open chats. Archive one first.`,
      total ? DOZO_BOT_CHATS_TOTAL_LIMIT_CODE : DOZO_BOT_CHATS_LIMIT_CODE,
    );
  }
}

const toChat = (row: ChatRow): DozoBotChat => ({
  id: row.threadId,
  botId: row.botId,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
  unread: row.unread ?? false,
  snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
});

/**
 * Extra chats in the caller's Space, oldest first, each with the caller's own read state: one
 * bot's, or without one every chat of the Space's bots that are not archived.
 */
export async function listChats(
  db: Db,
  actor: Actor,
  botId: string | undefined,
  includeArchived: boolean,
): Promise<DozoBotChat[]> {
  const rows = await db.$queryRaw<ChatRow[]>`
    SELECT c."threadId", c."botId", c.name,
      c."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      c."archivedAt" AT TIME ZONE 'UTC' AS "archivedAt",
      r.unread, r."snoozedUntil"
    FROM dozo_bot_chats c
    JOIN bots b ON b.id = c."botId"
    LEFT JOIN thread_reads r ON r."threadId" = c."threadId" AND r."userId" = ${actor.userId}
    WHERE c."spaceId" = ${actor.spaceId}
      AND (${botId ?? null}::text IS NULL OR c."botId" = ${botId ?? null})
      AND (${botId ?? null}::text IS NOT NULL OR b."archivedAt" IS NULL)
      AND (${includeArchived}::boolean OR c."archivedAt" IS NULL)
    ORDER BY c."createdAt", c."threadId"`;
  return rows.map(toChat);
}

async function chatRow(db: Db, actor: Actor, chatId: string): Promise<ChatRow> {
  const [row] = await db.$queryRaw<ChatRow[]>`
    SELECT c."threadId", c."botId", c.name,
      c."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      c."archivedAt" AT TIME ZONE 'UTC' AS "archivedAt",
      r.unread, r."snoozedUntil"
    FROM dozo_bot_chats c
    LEFT JOIN thread_reads r ON r."threadId" = c."threadId" AND r."userId" = ${actor.userId}
    WHERE c."threadId" = ${chatId} AND c."spaceId" = ${actor.spaceId}`;
  if (!row) throw new IsolationError();
  return row;
}

/**
 * Under the bot's row lock, so two creates cannot both pass the count, and a bot archived or
 * deleted since the caller's check is refused. The lock does not hold up writes that only point
 * at the bot (its messages and runs).
 */
async function assertRoomForOneMore(tx: Tx, botId: string, creating: boolean) {
  const bot = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM bots WHERE id = ${botId} AND "archivedAt" IS NULL FOR NO KEY UPDATE`;
  if (bot.length === 0) throw new IsolationError();
  const [counts] = await tx.$queryRaw<{ open: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::int AS open, count(*)::int AS total
    FROM dozo_bot_chats WHERE "botId" = ${botId}`;
  if (creating && (counts?.total ?? 0) >= DOZO_BOT_CHATS_TOTAL_MAX)
    throw new DozoBotChatsLimitError(true);
  if ((counts?.open ?? 0) >= DOZO_BOT_CHATS_MAX) throw new DozoBotChatsLimitError();
}

/**
 * A new extra chat: an ordinary thread of the bot's Space with no bot on it, so nothing that finds
 * a bot's chat by its bot (the main chat) ever finds this one, and its row here.
 */
export async function createChat(
  tx: Tx,
  actor: Actor,
  input: { botId: string; name: string },
): Promise<DozoBotChat> {
  await assertRoomForOneMore(tx, input.botId, true);
  const thread = await tx.thread.create({
    data: { spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  await tx.$executeRaw`
    INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name)
    VALUES (${thread.id}, ${input.botId}, ${actor.spaceId}, ${input.name})`;
  return chatRow(tx, actor, thread.id).then(toChat);
}

export async function renameChat(
  tx: Tx,
  actor: Actor,
  input: { chatId: string; name: string },
): Promise<DozoBotChat> {
  await tx.$executeRaw`
    UPDATE dozo_bot_chats SET name = ${input.name}
    WHERE "threadId" = ${input.chatId} AND "spaceId" = ${actor.spaceId}`;
  return chatRow(tx, actor, input.chatId).then(toChat);
}

export async function archiveChat(
  tx: Tx,
  actor: Actor,
  input: { chatId: string; archived: boolean },
): Promise<DozoBotChat> {
  const row = await chatRow(tx, actor, input.chatId);
  if (input.archived === (row.archivedAt !== null)) return toChat(row);
  if (!input.archived) await assertRoomForOneMore(tx, row.botId, false);
  await tx.$executeRaw`
    UPDATE dozo_bot_chats
    SET "archivedAt" = CASE WHEN ${input.archived}::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE "threadId" = ${input.chatId} AND "spaceId" = ${actor.spaceId}`;
  return chatRow(tx, actor, input.chatId).then(toChat);
}

/**
 * A bot's extra chats, for anyone in the Space who can chat with the bot, under the same check
 * that opens its main chat. Changing one leaves an archived bot's chats as they are, as its main
 * chat takes no new messages either. Inputs are the contract's, already checked. Reading and
 * writing an extra chat go through the chat routes, which take its id as `chatId`.
 */
export function dozoBotChats(deps: Pick<RouterDeps, "prisma" | "events">) {
  const { prisma } = deps;
  const changed = (actor: Actor) =>
    bestEffort(
      "bot chats signal",
      deps.events?.publishRosterChange?.({ spaceIds: [actor.spaceId] }),
    );
  const ofBot = async (actor: Actor, chatId: string) => {
    const row = await chatRow(prisma, actor, chatId);
    await resolveThreadTarget(prisma, actor, { botId: row.botId });
  };
  return {
    async list(actor: Actor, input: DozoBotChatsListInput) {
      if (input.botId)
        await resolveThreadTarget(prisma, actor, { botId: input.botId }, { includeArchived: true });
      return { chats: await listChats(prisma, actor, input.botId, input.includeArchived ?? false) };
    },
    async create(actor: Actor, input: DozoBotChatCreateInput) {
      await resolveThreadTarget(prisma, actor, { botId: input.botId });
      const chat = await prisma.$transaction((tx) => createChat(tx, actor, input));
      await changed(actor);
      return { chat };
    },
    async rename(actor: Actor, input: DozoBotChatRenameInput) {
      await ofBot(actor, input.chatId);
      const chat = await prisma.$transaction((tx) => renameChat(tx, actor, input));
      await changed(actor);
      return { chat };
    },
    async archive(actor: Actor, input: DozoBotChatArchiveInput) {
      await ofBot(actor, input.chatId);
      const chat = await prisma.$transaction((tx) => archiveChat(tx, actor, input));
      await changed(actor);
      return { chat };
    },
  };
}

/**
 * An extra chat from an account archive: its thread and its row in one transaction, as the
 * database wants a thread without an owner to be a bot chat when it commits.
 */
export async function dozoImportChat(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    chat: { name: string; archivedAt: string | null };
    thread: {
      historyCompactedUpToSeq: number | null;
      historyCompactionSummary: string | null;
      createdAt: string;
    };
  },
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // The limits hold for an archive too: a crafted one cannot give a bot more chats.
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR NO KEY UPDATE`;
    const [counts] = await tx.$queryRaw<{ open: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::int AS open, count(*)::int AS total
      FROM dozo_bot_chats WHERE "botId" = ${input.botId}`;
    if ((counts?.total ?? 0) >= DOZO_BOT_CHATS_TOTAL_MAX) throw new DozoBotChatsLimitError(true);
    if (!input.chat.archivedAt && (counts?.open ?? 0) >= DOZO_BOT_CHATS_MAX)
      throw new DozoBotChatsLimitError();
    const createdAt = new Date(input.thread.createdAt);
    const thread = await tx.thread.create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        historyCompactedUpToSeq: input.thread.historyCompactedUpToSeq,
        historyCompactionSummary: input.thread.historyCompactionSummary,
        createdAt,
      },
      select: { id: true },
    });
    const archivedAt = input.chat.archivedAt;
    await tx.$executeRaw`
      INSERT INTO dozo_bot_chats ("threadId", "botId", "spaceId", name, "createdAt", "archivedAt")
      VALUES (${thread.id}, ${input.botId}, ${input.spaceId}, ${input.chat.name},
        ${createdAt.toISOString()}::timestamptz,
        ${archivedAt ? new Date(archivedAt).toISOString() : null}::timestamptz)`;
    return thread.id;
  });
}

/** The app's routes for a bot's extra chats. */
export function dozoBotChatRoutes(ctx: RouterContext) {
  const chats = dozoBotChats(ctx.deps);
  const { authed } = ctx;
  return {
    dozoChats: {
      list: authed.dozoChats.list.handler(({ context, input }) => chats.list(context.actor, input)),
      create: authed.dozoChats.create.handler(({ context, input }) =>
        chats.create(context.actor, input),
      ),
      rename: authed.dozoChats.rename.handler(({ context, input }) =>
        chats.rename(context.actor, input),
      ),
      archive: authed.dozoChats.archive.handler(({ context, input }) =>
        chats.archive(context.actor, input),
      ),
    },
  };
}
