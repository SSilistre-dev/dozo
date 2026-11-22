import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { dozoBotChatOf, IsolationError } from "@rakazo/db";

/**
 * A routine named in a message runs where the message was written: in the bot's extra chat when
 * the message is there, otherwise in the bot's main chat, as before extra chats. The chat the
 * routine posts in on its own (`routines.threadId`) is left as it is.
 */
export async function dozoMentionedRoutine<
  Target extends { botId: string; threadId: string; dozoMainThreadId: string },
>(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId">,
  message: { chatBotId?: string; chatId?: string },
  target: Target,
): Promise<Target> {
  if (message.chatBotId !== target.botId || !message.chatId)
    return { ...target, threadId: target.dozoMainThreadId };
  const chat = await dozoBotChatOf(prisma, {
    threadId: message.chatId,
    botId: target.botId,
    spaceId: actor.spaceId,
  });
  // The message goes nowhere else: a chat that cannot take it is not found, never the main chat.
  if (!chat || chat.archived) throw new IsolationError();
  return { ...target, threadId: message.chatId };
}
