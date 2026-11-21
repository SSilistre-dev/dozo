import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/**
 * Which of a bot's chats a request names: its main chat, or with `chatId` one of its extra chats
 * (`dozo_bot_chats`). A `chatId` that is not this bot's extra chat in the caller's Space is not
 * found; it never falls back to the main chat.
 */
export async function dozoChatThreadId(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  botId: string,
  mainThreadId: string,
  chatId: string | undefined,
): Promise<string> {
  if (!chatId || chatId === mainThreadId) return mainThreadId;
  const [row] = await prisma.$queryRaw<{ threadId: string }[]>`
    SELECT "threadId" FROM dozo_bot_chats
    WHERE "threadId" = ${chatId} AND "botId" = ${botId} AND "spaceId" = ${actor.spaceId}`;
  if (!row) throw new IsolationError();
  return row.threadId;
}

/** A group has one chat: naming an extra chat with it is not found. */
export function dozoRefuseChatOnGroup(input: { chatId?: string }): void {
  if (input.chatId) throw new IsolationError();
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
