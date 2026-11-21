import type { PrismaClient } from "@rakazo/db";

/** Any client or transaction that can run raw SQL. */
export type DozoMarkDb = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/**
 * Whether a run's bot holds text that came in with a personal access token (dozo-token-source.ts):
 * a message sent with one in the bot's chat or the run's own chat, still there (clearing the chat
 * removes it); a mark left when text from such a run was delivered to this bot, until this bot's
 * chat is cleared after it, or for good when the mark lasts (a bot or routine such a run made);
 * or the same for a bot it was spawned from. Messages and marks from before the owner trusted the
 * bot again (`dozo_token_trust`) do not count, unless `ignoreTrust`: they are still in its history.
 *
 * `'api:%'` is DOZO_TOKEN_NONCE_PREFIX written out, so the partial index on messages is used.
 * Upstream's `createdAt` columns are UTC without a zone, so they are read as UTC before comparing.
 */
export async function dozoBotTokenTainted(
  db: DozoMarkDb,
  run: { botId: string; threadId: string },
  options: { ignoreTrust?: boolean } = {},
): Promise<boolean> {
  const trust = !options.ignoreTrust;
  const rows = await db.$queryRaw<{ sourced: boolean }[]>`
    WITH RECURSIVE lineage (id, depth) AS (
      SELECT ${run.botId}::text, 0
      UNION ALL
      SELECT b."parentBotId", l.depth + 1 FROM bots b JOIN lineage l ON b.id = l.id
      WHERE b."parentBotId" IS NOT NULL AND l.depth < 8
    ),
    since AS (
      SELECT l.id, CASE WHEN ${trust} THEN tr."trustedAt" END AS at
      FROM lineage l LEFT JOIN dozo_token_trust tr ON tr."botId" = l.id
    )
    SELECT (
      EXISTS (SELECT 1 FROM messages m
        WHERE m."threadId" = ${run.threadId} AND m."clientNonce" LIKE 'api:%'
          AND m."createdAt" AT TIME ZONE 'UTC' > COALESCE(
            (SELECT at FROM since WHERE id = ${run.botId}), '-infinity'))
      OR EXISTS (SELECT 1 FROM since s JOIN threads t ON t."botId" = s.id
        JOIN messages m ON m."threadId" = t.id
        WHERE m."clientNonce" LIKE 'api:%'
          AND m."createdAt" AT TIME ZONE 'UTC' > COALESCE(s.at, '-infinity'))
      OR EXISTS (SELECT 1 FROM since s JOIN dozo_token_taints x ON x."botId" = s.id
        WHERE x."createdAt" > COALESCE(s.at, '-infinity')
          AND (x.lasting OR NOT EXISTS (SELECT 1 FROM threads t JOIN events e ON e."threadId" = t.id
            WHERE t."botId" = x."botId" AND e.type = 'thread.cleared'
              AND e."createdAt" AT TIME ZONE 'UTC' > x."createdAt")))
    ) AS sourced`;
  return rows[0]?.sourced === true;
}

/**
 * Marks a bot that text from a marked run reached (a message or a run's answer delivered to it, a
 * handoff, its instructions or a ticket written for it), at the moment it is delivered. One mark
 * per bot: marking again moves it to now, so a chat cleared before this does not end it.
 */
export async function dozoMarkBot(
  db: DozoMarkDb,
  input: { spaceId: string; botId: string; fromRunId: string },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dozo_token_taints ("spaceId", "botId", "fromRunId")
    SELECT ${input.spaceId}, b.id, ${input.fromRunId} FROM bots b
    WHERE b.id = ${input.botId} AND b."spaceId" = ${input.spaceId}
    ON CONFLICT ("botId") WHERE NOT "lasting" AND "routineId" IS NULL
    DO UPDATE SET "createdAt" = CURRENT_TIMESTAMP, "fromRunId" = EXCLUDED."fromRunId"`;
}

/**
 * Where text is delivered from one bot's run to another bot (messageBot, which also returns a
 * delegated run's answer, and handoffToGroupBot): the receiver is marked when the sender's bot is.
 * Written inside the delivery's transaction, so a delivery that does not commit leaves no mark.
 */
export async function dozoMarkReached(
  db: DozoMarkDb,
  input: {
    run: { id: string; botId: string; threadId: string; spaceId: string };
    targetBotId: string;
  },
  /** Where the sender's mark is read, when not the delivery's transaction. */
  read: Pick<DozoMarkDb, "$queryRaw"> = db,
): Promise<void> {
  if (!(await dozoBotTokenTainted(read as DozoMarkDb, input.run))) return;
  await dozoMarkBot(db, {
    spaceId: input.run.spaceId,
    botId: input.targetBotId,
    fromRunId: input.run.id,
  });
}
