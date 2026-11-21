import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/**
 * Which of a bot's chats a request names: its main chat (`botId`), or one of its extra chats
 * (`chatBotId` with `chatId`, `dozo_bot_chats`). An extra chat that is not this bot's in the
 * caller's Space is not found; it never falls back to the main chat. An archived extra chat is
 * found only where an archived bot's chat is (`includeArchived`, as the export and pins read):
 * nothing new is written to it, as nothing is to an archived bot's chat.
 */
export async function dozoChatThreadId(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  botId: string,
  mainThreadId: string,
  input: { chatBotId?: string; chatId?: string },
  options: { includeArchived?: boolean } = {},
): Promise<string> {
  if (!input.chatBotId) {
    // A chat id travels only with chatBotId; one beside botId was not meant for this API.
    if (input.chatId) throw new IsolationError();
    return mainThreadId;
  }
  if (!input.chatId) throw new IsolationError();
  if (input.chatId === mainThreadId) return mainThreadId;
  const [row] = await prisma.$queryRaw<{ threadId: string }[]>`
    SELECT "threadId" FROM dozo_bot_chats
    WHERE "threadId" = ${input.chatId} AND "botId" = ${botId} AND "spaceId" = ${actor.spaceId}
      AND (${options.includeArchived ?? false}::boolean OR "archivedAt" IS NULL)`;
  if (!row) throw new IsolationError();
  return row.threadId;
}

/** A group has one chat: naming an extra chat with it is not found. */
export function dozoRefuseChatOnGroup(input: { chatBotId?: string; chatId?: string }): void {
  if (input.chatId || input.chatBotId) throw new IsolationError();
}

/** True when a resolved bot target is one of the bot's extra chats. */
export function isDozoExtraChat(target: {
  kind: string;
  threadId: string;
  bot?: { thread?: { id: string } | null };
}): boolean {
  return target.kind === "bot" && target.threadId !== target.bot?.thread?.id;
}

/**
 * What extra chats do not do yet answers so, instead of acting on the bot's main chat.
 */
export class DozoExtraChatUnsupportedError extends ClientError {
  constructor(what: string) {
    super("BAD_REQUEST", `${what} works in a bot's main chat only.`, "dozo_extra_chat_unsupported");
  }
}

export function dozoMainChatOnly(
  target: Parameters<typeof isDozoExtraChat>[0],
  what: string,
): void {
  if (isDozoExtraChat(target)) throw new DozoExtraChatUnsupportedError(what);
}

/**
 * For a route that takes a chat target but reads its bot or group itself (an attachment, a
 * section): a bot's extra chat is not a target there. Without this, the bot and group would both
 * be unset and the route would act on the Space's first one.
 */
export function dozoBotOrGroupOnly(input: { chatBotId?: string; chatId?: string }): void {
  if (input.chatBotId || input.chatId)
    throw new ClientError(
      "BAD_REQUEST",
      "Name the bot or the group here, not one of a bot's chats.",
      "dozo_extra_chat_not_a_target",
    );
}
