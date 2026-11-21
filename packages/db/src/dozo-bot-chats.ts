import type { Prisma, PrismaClient } from "./client.js";

type Db = Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">;

/**
 * A bot's extra chats (`dozo_bot_chats`): threads of the bot's Space with no owner column set,
 * tied to their bot by that table only. The bot's main chat stays the thread whose `botId` is the
 * bot. "The chat's bot" is `threads.botId`, or for an extra chat its row's bot.
 */

/** The bot an extra chat belongs to, or null when the thread is not an extra chat. */
export async function dozoChatBotId(db: Db, threadId: string): Promise<string | null> {
  const [row] = await db.$queryRaw<{ botId: string }[]>`
    SELECT "botId" FROM dozo_bot_chats WHERE "threadId" = ${threadId}`;
  return row?.botId ?? null;
}

/**
 * The thread as the runtime reads it, with an extra chat's bot in `botId`, so a turn, its memory
 * and its summary treat the chat as that bot's own, as they treat its main chat. Only for
 * reading: nothing writes this `botId` back, and code that finds a chat by its bot still finds
 * the main one.
 */
export async function withDozoChatBot<T extends { botId: string | null }>(
  db: Db,
  threadId: string,
  thread: T,
): Promise<T>;
export async function withDozoChatBot<T extends { botId: string | null }>(
  db: Db,
  threadId: string,
  thread: T | null,
): Promise<T | null>;
export async function withDozoChatBot<T extends { botId: string | null }>(
  db: Db,
  threadId: string,
  thread: T | null,
): Promise<T | null> {
  if (!thread || thread.botId || ownedOtherwise(thread)) return thread;
  const botId = await dozoChatBotId(db, threadId);
  return botId ? { ...thread, botId } : thread;
}

/** A thread whose read includes another owner column set: never an extra chat. */
function ownedOtherwise(thread: object): boolean {
  const owners = thread as Record<string, unknown>;
  return Boolean(owners.groupId || owners.externalConversationId || owners.helperBotId);
}

/** A bot's extra chats in a Space, as `{ id, botId }` thread rows, archived ones included. */
export async function dozoBotChatThreads(
  db: Db,
  spaceId: string,
  botId: string,
  threadId?: string,
): Promise<Array<{ id: string; botId: string }>> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "threadId" AS id FROM dozo_bot_chats
    WHERE "spaceId" = ${spaceId} AND "botId" = ${botId}
      AND (${threadId ?? null}::text IS NULL OR "threadId" = ${threadId ?? null})`;
  return rows.map((row) => ({ id: row.id, botId }));
}

/** An extra chat's bot as a chat notice names it, or null when the thread is not an extra chat. */
export async function dozoChatNoticeBot(
  db: Pick<PrismaClient, "$queryRaw" | "bot">,
  threadId: string,
): Promise<{
  id: string;
  name: string;
  color: string;
  avatarSet: string;
  notifyOnFinish: boolean;
} | null> {
  const botId = await dozoChatBotId(db, threadId);
  if (!botId) return null;
  return db.bot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, color: true, avatarSet: true, notifyOnFinish: true },
  });
}

/** What an account archive keeps of an extra chat, beside its thread. */
export type DozoExportedChat = { botId: string; name: string; archivedAt: string | null };

/** The extra chats of these bots in the Space, by thread, for an account archive. */
export async function dozoExportChats(
  db: Db,
  spaceId: string,
  botIds: string[],
): Promise<Map<string, DozoExportedChat>> {
  if (botIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { threadId: string; botId: string; name: string; archivedAt: Date | null }[]
  >`
    SELECT "threadId", "botId", name, "archivedAt" AT TIME ZONE 'UTC' AS "archivedAt"
    FROM dozo_bot_chats WHERE "spaceId" = ${spaceId} AND "botId" = ANY(${botIds})`;
  return new Map(
    rows.map((row) => [
      row.threadId,
      { botId: row.botId, name: row.name, archivedAt: row.archivedAt?.toISOString() ?? null },
    ]),
  );
}

/** The archive record's extra-chat part, when the thread is one. */
export function dozoExportChat(chats: Map<string, DozoExportedChat>, threadId: string) {
  const chat = chats.get(threadId);
  return chat ? { dozoChat: chat } : {};
}
