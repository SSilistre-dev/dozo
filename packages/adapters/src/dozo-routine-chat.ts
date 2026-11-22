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
 * triggers, retries and test runs all go through here, so quiet hours, the 12-hour catch-up, the
 * daily send limit and the queue meet the same chat. Without a chat, or one that is not the bot's,
 * it is the bot's main chat, as before.
 *
 * An archived chat takes nothing new, so a routine pointed at one runs in the main chat instead
 * and says so there once per run: the work is not lost, and it never lands anywhere unannounced.
 * Bringing the chat back sends the routine there again.
 */

/** The thread a run of the routine posts in, with the archived chat it stands in for, if any. */
export type DozoRoutineThread = { id: string; dozoArchivedChat?: string };

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
  return { id: bot.thread.id, dozoArchivedChat: chat.name };
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

/** What the main chat shows when a run stood in for an archived chat. */
export function dozoRoutineChatNote(routineName: string, chatName: string): string {
  return `${routineName} ran here: its chat ${chatName} is archived.`;
}

/** Says once, in the main chat, that this run stands in for the routine's archived chat. */
export async function dozoNoteRoutineChat(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  routine: { name: string; spaceId: string },
  botId: string,
  thread: DozoRoutineThread,
  run: { id: string },
): Promise<void> {
  if (!thread.dozoArchivedChat) return;
  const blocks = [
    { kind: "meta" as const, text: dozoRoutineChatNote(routine.name, thread.dozoArchivedChat) },
  ];
  const clientNonce = `dozo-routine-chat:${run.id}`;
  try {
    const seq = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        botId,
        role: "system",
        blocks,
        clientNonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: routine.spaceId,
        threadId: thread.id,
        botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
      return event.seq;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    await bestEffort("routine chat note signal", deps.events.notify(thread.id, seq));
  } catch (cause) {
    // The run is queued either way; a second wake of the same run already wrote the note.
    if (!isUniqueViolation(cause)) getLogger().error("dozo.routine_chat_note_failed", cause);
  }
}
