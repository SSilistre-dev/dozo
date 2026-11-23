import type { PrismaClient } from "./client.js";

/**
 * The runs a backup model answered (`dozo_backup_replies`, migration
 * `20270122140000_dozo_backup_replies`): one row per run, the backup it ran on last.
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/**
 * Records what a run is running on: a backup, or with `backup` null the model it chose, which
 * clears the row (a later attempt of the run may run on the chosen model again).
 */
export async function recordBackupReply(
  db: Db,
  run: { id: string },
  backup: { provider: string; modelId: string } | null,
): Promise<void> {
  if (!backup) {
    await db.$executeRaw`DELETE FROM "dozo_backup_replies" WHERE "runId" = ${run.id}`;
    return;
  }
  await db.$executeRaw`
    INSERT INTO "dozo_backup_replies" ("runId", "threadId", "spaceId", "provider", "modelId")
    SELECT r."id", r."threadId", r."spaceId", ${backup.provider}, ${backup.modelId}
    FROM "runs" r WHERE r."id" = ${run.id}
    ON CONFLICT ("runId") DO UPDATE SET
      "provider" = EXCLUDED."provider",
      "modelId" = EXCLUDED."modelId",
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/**
 * The chat's latest replies a backup wrote for runs of `userId`'s own, by message, with that
 * backup. Another member of a shared chat is told nothing: which backup ran, and its name, is
 * that person's own setting.
 */
export async function readBackupReplies(
  db: Db,
  threadId: string,
  userId: string,
  limit = 200,
): Promise<Array<{ messageId: string; provider: string; modelId: string }>> {
  return db.$queryRaw`
    SELECT m."id" AS "messageId", b."provider", b."modelId"
    FROM "dozo_backup_replies" b
    JOIN "runs" r ON r."id" = b."runId" AND r."userId" = ${userId}
    JOIN "messages" m ON m."runId" = b."runId" AND m."threadId" = b."threadId"
    WHERE b."threadId" = ${threadId} AND m."role" = 'bot'
    ORDER BY m."seq" DESC
    LIMIT ${limit}`;
}
