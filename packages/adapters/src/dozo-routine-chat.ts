import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  dozoBotChatOf,
  isUniqueViolation,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

/**
 * Where a bot's routine posts: the chat it was made in or pointed at (`routines.threadId`), when
 * that is one of the bot's extra chats (`dozo_bot_chats`). Schedules, one-time waits, change
 * triggers, the daily digest, retries and Run now all go through here, so quiet hours, the 12-hour
 * catch-up, the daily send limit and the queue meet the same chat. Without a chat, or one that is
 * not the bot's, it is the bot's main chat, as before.
 *
 * An archived chat takes nothing new, so a routine pointed at one runs in the main chat instead
 * and says so there, once for that archiving: the work is not lost, and it never lands anywhere
 * unannounced. Bringing the chat back sends the routine there again.
 */

/** The archived chat a routine's runs stand in for in the main chat. */
export type DozoArchivedRoutineChat = { chatId: string; name: string; archivedAt: Date | null };

/** The thread a run of the routine posts in, with the archived chat it stands in for, if any. */
export type DozoRoutineThread = { id: string; dozoArchivedChat?: DozoArchivedRoutineChat };

export async function dozoRoutineThread(
  deps: { prisma: Pick<PrismaClient, "$queryRaw"> },
  routine: { threadId: string | null; spaceId: string },
  bot: { id: string; thread: { id: string } },
  /** The thread upstream already accepted: the bot's main chat or one of its groups. */
  found: { id: string } | null,
): Promise<DozoRoutineThread> {
  if (found || !routine.threadId) return found ?? { id: bot.thread.id };
  const chat = await dozoBotChatOf(deps.prisma, {
    threadId: routine.threadId,
    botId: bot.id,
    spaceId: routine.spaceId,
  });
  if (!chat) return { id: bot.thread.id };
  if (!chat.archived) return { id: routine.threadId };
  const archived = { chatId: routine.threadId, name: chat.name, archivedAt: chat.archivedAt };
  return { id: bot.thread.id, dozoArchivedChat: archived };
}

/** True when `threadId` is an open extra chat of the bot: a retry or test run may post there. */
export async function dozoOpenRoutineChat(
  db: Pick<PrismaClient, "$queryRaw">,
  input: { threadId: string | null; botId: string; spaceId: string },
): Promise<boolean> {
  if (!input.threadId) return false;
  const chat = await dozoBotChatOf(db, { ...input, threadId: input.threadId });
  return chat !== null && !chat.archived;
}

/** What the main chat shows, in the routine owner's language, for a routine of an archived chat. */
export function dozoRoutineChatNote(
  routineName: string,
  chatName: string,
  locale: string | null | undefined,
): string {
  return locale?.toLowerCase().startsWith("tr")
    ? `${routineName}, sohbeti ${chatName} arşivliyken buraya yazar.`
    : `${routineName} posts here while its chat ${chatName} is archived.`;
}

/**
 * Says in the main chat, once for each time its chat was archived, that the routine posts there
 * meanwhile. The key is the routine, the chat and when it was archived: a routine that wakes every
 * few minutes writes one line, and archiving the chat again after bringing it back writes a new one.
 */
export async function dozoNoteRoutineChat(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  routine: { id: string; name: string; spaceId: string; userId: string },
  botId: string,
  thread: DozoRoutineThread,
): Promise<void> {
  const chat = thread.dozoArchivedChat;
  if (!chat) return;
  const clientNonce = `dozo-routine-chat:${routine.id}:${chat.chatId}:${chat.archivedAt?.getTime() ?? 0}`;
  const threadId = thread.id;
  try {
    const seq = await deps.prisma.$transaction(async (tx) => {
      const said = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId, clientNonce } },
        select: { id: true },
      });
      if (said) return undefined;
      const owner = await tx.user.findUnique({
        where: { id: routine.userId },
        select: { locale: true },
      });
      const text = dozoRoutineChatNote(routine.name, chat.name, owner?.locale);
      const blocks = [{ kind: "meta" as const, text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        botId,
        role: "system",
        blocks,
        clientNonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: routine.spaceId,
        threadId,
        botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
      return event.seq;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    if (seq !== undefined)
      await bestEffort("routine chat note signal", deps.events.notify(threadId, seq));
  } catch (cause) {
    // The routine runs either way; a wake racing this one already wrote the line.
    if (!isUniqueViolation(cause)) getLogger().error("dozo.routine_chat_note_failed", cause);
  }
}
