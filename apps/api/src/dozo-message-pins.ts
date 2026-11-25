import type { Actor, DozoMessagePin } from "@rakazo/contracts";
import { DOZO_MESSAGE_PINS_MAX, MessageRole } from "@rakazo/contracts";
import { messageReplyPreview } from "@rakazo/core/message-quote";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, storedMessageBlocks, withDozoChatBot } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";
import { resolveThreadTarget } from "./threads/thread-target.js";

type Db = Pick<PrismaClient, "thread" | "message" | "$queryRaw" | "$executeRaw">;

/**
 * A chat the caller can read: a bot's (main or extra) or a group's, through the same target check the transcript
 * uses, archived ones included. Helper and chat-app conversations have no pins.
 */
export async function readableThread(prisma: PrismaClient, actor: Actor, threadId: string) {
  const thread = await withDozoChatBot(
    prisma,
    threadId,
    await prisma.thread.findFirst({
      where: { id: threadId, spaceId: actor.spaceId },
      select: { botId: true, groupId: true },
    }),
  );
  const input = thread?.botId
    ? { chatBotId: thread.botId, chatId: threadId }
    : thread?.groupId
      ? { groupId: thread.groupId }
      : null;
  if (!input) throw new IsolationError();
  const target = await resolveThreadTarget(prisma, actor, input, { includeArchived: true });
  if (target.threadId !== threadId) throw new IsolationError();
}

/** The caller's pins in one chat, newest first, each with the preview a reply quote shows. */
export async function listPins(db: Db, actor: Actor, threadId: string): Promise<DozoMessagePin[]> {
  const rows = await db.$queryRaw<{ messageId: string }[]>`
    SELECT "messageId" FROM dozo_message_pins
    WHERE "userId" = ${actor.userId} AND "threadId" = ${threadId}
    ORDER BY "createdAt" DESC, "messageId" DESC
    LIMIT ${DOZO_MESSAGE_PINS_MAX}`;
  if (rows.length === 0) return [];
  const messages = await db.message.findMany({
    where: { threadId, id: { in: rows.map((row) => row.messageId) } },
    select: { id: true, role: true, botId: true, blocks: true },
  });
  const byId = new Map(messages.map((message) => [message.id, message]));
  return rows.flatMap(({ messageId }) => {
    const message = byId.get(messageId);
    const role = MessageRole.safeParse(message?.role);
    if (!message || !role.success) return [];
    const preview = messageReplyPreview(
      storedMessageBlocks(message),
      role.data,
      message.botId ?? undefined,
    );
    return [{ messageId, preview }];
  });
}

/**
 * Pins or unpins one message of the chat. Past the most a chat holds, the oldest pins go. A message
 * deleted at the same time is not pinned: the insert reads it from the chat in the same statement.
 */
export async function setPin(
  db: Db,
  actor: Actor,
  input: { threadId: string; messageId: string; pinned: boolean },
): Promise<void> {
  const { threadId, messageId } = input;
  if (!input.pinned) {
    await db.$executeRaw`
      DELETE FROM dozo_message_pins
      WHERE "userId" = ${actor.userId} AND "threadId" = ${threadId} AND "messageId" = ${messageId}`;
    return;
  }
  const message = await db.message.findFirst({
    where: { id: messageId, threadId },
    select: { id: true },
  });
  if (!message) throw new IsolationError();
  await db.$executeRaw`
    INSERT INTO dozo_message_pins ("userId", "spaceId", "threadId", "messageId")
    SELECT ${actor.userId}, ${actor.spaceId}, m."threadId", m."id"
    FROM messages m WHERE m."id" = ${messageId} AND m."threadId" = ${threadId}
    ON CONFLICT ("userId", "messageId") DO NOTHING`;
  await db.$executeRaw`
    DELETE FROM dozo_message_pins
    WHERE "userId" = ${actor.userId} AND "threadId" = ${threadId} AND "messageId" NOT IN (
      SELECT "messageId" FROM dozo_message_pins
      WHERE "userId" = ${actor.userId} AND "threadId" = ${threadId}
      ORDER BY "createdAt" DESC, "messageId" DESC
      LIMIT ${DOZO_MESSAGE_PINS_MAX}
    )`;
}

/**
 * Pinned messages, the caller's own. A pin is personal chat state, like what they have read: a
 * change signals only their own apps, on the roster stream that already carries that state.
 */
export function dozoMessagePinRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    pins: authed.dozoMessages.pins.handler(async ({ context, input }) => {
      await readableThread(deps.prisma, context.actor, input.threadId);
      return { pins: await listPins(deps.prisma, context.actor, input.threadId) };
    }),
    pin: authed.dozoMessages.pin.handler(async ({ context, input }) => {
      await readableThread(deps.prisma, context.actor, input.threadId);
      await setPin(deps.prisma, context.actor, input);
      void deps.events?.publishRosterChange?.({ userIds: [context.actor.userId] });
      return { pinned: input.pinned };
    }),
  };
}
