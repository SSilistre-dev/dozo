import type { Actor, DozoBotChat } from "@rakazo/contracts";
import { DOZO_BOT_CHATS_LIMIT_CODE, DOZO_BOT_CHATS_MAX } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
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
};

export class DozoBotChatsLimitError extends ClientError {
  constructor() {
    super(
      "CONFLICT",
      `A bot holds at most ${DOZO_BOT_CHATS_MAX} open chats. Archive one first.`,
      DOZO_BOT_CHATS_LIMIT_CODE,
    );
  }
}

const toChat = (row: ChatRow): DozoBotChat => ({
  id: row.threadId,
  botId: row.botId,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

/** The bot's extra chats in the caller's Space, oldest first. */
export async function listChats(
  db: Db,
  actor: Actor,
  botId: string,
  includeArchived: boolean,
): Promise<DozoBotChat[]> {
  const rows = await db.$queryRaw<ChatRow[]>`
    SELECT "threadId", "botId", name,
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      "archivedAt" AT TIME ZONE 'UTC' AS "archivedAt"
    FROM dozo_bot_chats
    WHERE "botId" = ${botId} AND "spaceId" = ${actor.spaceId}
      AND (${includeArchived}::boolean OR "archivedAt" IS NULL)
    ORDER BY "createdAt", "threadId"`;
  return rows.map(toChat);
}

async function chatRow(db: Db, actor: Actor, chatId: string): Promise<ChatRow> {
  const [row] = await db.$queryRaw<ChatRow[]>`
    SELECT "threadId", "botId", name,
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      "archivedAt" AT TIME ZONE 'UTC' AS "archivedAt"
    FROM dozo_bot_chats
    WHERE "threadId" = ${chatId} AND "spaceId" = ${actor.spaceId}`;
  if (!row) throw new IsolationError();
  return row;
}

/**
 * Under the bot's row lock, so two creates cannot both pass the count, and a bot deleted at the
 * same time takes the new chat with it.
 */
async function assertRoomForOneMore(tx: Tx, botId: string) {
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
  const [{ open }] = await tx.$queryRaw<{ open: number }[]>`
    SELECT count(*)::int AS open FROM dozo_bot_chats
    WHERE "botId" = ${botId} AND "archivedAt" IS NULL`;
  if (open >= DOZO_BOT_CHATS_MAX) throw new DozoBotChatsLimitError();
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
  await assertRoomForOneMore(tx, input.botId);
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
  if (!input.archived) await assertRoomForOneMore(tx, row.botId);
  await tx.$executeRaw`
    UPDATE dozo_bot_chats
    SET "archivedAt" = CASE WHEN ${input.archived}::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE "threadId" = ${input.chatId} AND "spaceId" = ${actor.spaceId}`;
  return chatRow(tx, actor, input.chatId).then(toChat);
}

/**
 * A bot's extra chats, for anyone in the Space who can chat with the bot, under the same check
 * that opens its main chat. Changing one leaves an archived bot's chats as they are, as its main
 * chat takes no new messages either. Sending to or reading an extra chat is not here yet: every
 * existing route reaches a chat through its bot or group, so it refuses an extra chat's id as not
 * found instead of answering for another chat.
 */
export function dozoBotChatRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
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
    dozoChats: {
      list: authed.dozoChats.list.handler(async ({ context, input }) => {
        await resolveThreadTarget(
          prisma,
          context.actor,
          { botId: input.botId },
          { includeArchived: true },
        );
        const includeArchived = input.includeArchived ?? false;
        return { chats: await listChats(prisma, context.actor, input.botId, includeArchived) };
      }),
      create: authed.dozoChats.create.handler(async ({ context, input }) => {
        await resolveThreadTarget(prisma, context.actor, { botId: input.botId });
        const chat = await prisma.$transaction((tx) => createChat(tx, context.actor, input));
        await changed(context.actor);
        return { chat };
      }),
      rename: authed.dozoChats.rename.handler(async ({ context, input }) => {
        await ofBot(context.actor, input.chatId);
        const chat = await prisma.$transaction((tx) => renameChat(tx, context.actor, input));
        await changed(context.actor);
        return { chat };
      }),
      archive: authed.dozoChats.archive.handler(async ({ context, input }) => {
        await ofBot(context.actor, input.chatId);
        const chat = await prisma.$transaction((tx) => archiveChat(tx, context.actor, input));
        await changed(context.actor);
        return { chat };
      }),
    },
  };
}
