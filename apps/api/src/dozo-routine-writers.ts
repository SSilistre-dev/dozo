import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { recordRoutineWriter } from "@rakazo/db";

/**
 * Who a routine save in the app or the API records as its last writer (dozo_routine_writers), or
 * undefined to leave the record as it is. Only text that reaches the model when the routine runs
 * counts: its prompt; its watch, which the note a change trigger adds names; and its name, which the
 * note its chat gets while archived carries. Turning it on or off, its times, triggers, model or
 * target chat do not. Sending the prompt, changed or not, makes it the sender's: the bot's owner
 * ("owner") or another member or guest ("member"). A member's name or watch makes it theirs too, but
 * the owner's does not make a member's prompt theirs.
 */
export function routineWriterFor(
  actor: Actor,
  bot: { userId: string },
  sent: { prompt?: unknown; name?: unknown; watch?: unknown },
): "owner" | "member" | undefined {
  const fromOwner = actor.userId === bot.userId;
  if (sent.prompt !== undefined) return fromOwner ? "owner" : "member";
  if (!fromOwner && (sent.name !== undefined || sent.watch !== undefined)) return "member";
  return undefined;
}

/**
 * Saves a routine through `write`, recording `writer` in the same transaction: a record that cannot
 * be written fails the save, so an older owner's record never stays on someone else's text. With no
 * writer, the save runs as it would without the record.
 */
export async function saveRoutineNoted<T extends { id: string; spaceId: string }>(
  prisma: PrismaClient,
  writer: string | undefined,
  write: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!writer) return write(prisma);
  return prisma.$transaction(async (tx) => {
    const row = await write(tx);
    await recordRoutineWriter(tx, { routineId: row.id, spaceId: row.spaceId }, writer);
    return row;
  });
}
