import { DOZO_DEFAULT_DAILY_SENDS } from "@rakazo/contracts";
import { wallClock } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw"> | Prisma.TransactionClient;

/** How many sends each of the account's bots may make in a day without asking. */
export async function readDozoDailySends(db: Db, userId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ dailySends: number }>>`
    SELECT "dailySends" FROM dozo_send_limits WHERE "userId" = ${userId}`;
  return rows[0]?.dailySends ?? DOZO_DEFAULT_DAILY_SENDS;
}

export async function saveDozoDailySends(
  db: Db,
  userId: string,
  dailySends: number,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dozo_send_limits ("userId", "dailySends") VALUES (${userId}, ${dailySends})
    ON CONFLICT ("userId") DO UPDATE SET "dailySends" = EXCLUDED."dailySends",
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/**
 * Counts the sends one call makes for the member without asking (a batch can make several), on
 * today's date in the member's timezone. Full when they would take the bot past the account's
 * number for today: then nothing is counted and the call asks instead. One conditional upsert, so
 * concurrent sends on any instance never count past the number.
 */
export async function takeDozoDailySend(
  db: Db,
  send: { userId: string; botId: string; sends: number },
  now = new Date(),
): Promise<{ full: false } | { full: true; dailySends: number }> {
  const [account] = await db.$queryRaw<
    Array<{ timezone: string | null; dailySends: number | null }>
  >`
    SELECT u.timezone, l."dailySends"
    FROM "user" u LEFT JOIN dozo_send_limits l ON l."userId" = u.id
    WHERE u.id = ${send.userId}`;
  const dailySends = account?.dailySends ?? DOZO_DEFAULT_DAILY_SENDS;
  const day = wallClock(now, account?.timezone ?? "UTC").slice(0, 10);
  await db.$executeRaw`
    DELETE FROM dozo_daily_sends
    WHERE "userId" = ${send.userId} AND "botId" = ${send.botId} AND day < ${day}::date - 1`;
  const counted = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO dozo_daily_sends ("userId", "botId", day, count)
    SELECT ${send.userId}, ${send.botId}, ${day}::date, ${send.sends}
    WHERE ${send.sends} <= ${dailySends}
    ON CONFLICT ("userId", "botId", day) DO UPDATE SET count = dozo_daily_sends.count + ${send.sends}
    WHERE dozo_daily_sends.count + ${send.sends} <= ${dailySends}
    RETURNING count`;
  return counted.length ? { full: false } : { full: true, dailySends };
}
