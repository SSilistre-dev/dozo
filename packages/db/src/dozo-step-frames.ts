import type { Prisma, PrismaClient } from "./database/client.js";
import { runAsSystem, runAsSystemInTransaction } from "./database/row-security.js";
import { lockSharedSpace, sharedSpaceLimit, usedBytes } from "./dozo-shared-space.js";

const MB = 1024 * 1024;

/**
 * The extra frames a bot's replies keep for replays (every one beyond the reply's last screenshot,
 * which was kept before replays) take at most this much per bot; the oldest replies' go first.
 */
export const STEP_FRAMES_BOT_BYTES = 50 * MB;
/** Extra frames never take the last part of the organization's shared space. */
export const STEP_FRAMES_FREE_SHARE = 0.1;
/** An extra frame's row while its reply is still being written; a run that ends without it loses it. */
export const STEP_FRAME_PENDING = "step frame (pending)";
/** An extra frame its finished reply keeps. */
export const STEP_FRAME_KEPT = "step frame";

const FINISHED_RUN = ["completed", "failed", "cancelled"];

type Removed = { id: string; storageKey: string };

/**
 * Whether a reply of this run could ever be published as a replay: the owner's own one-to-one
 * chat (main or extra) with their own bot, in a run they started. Never a group, a helper chat or
 * a chat app's conversation. `thread.botId` is the chat's bot, an extra chat's included. The
 * replay's own check (apps/api/src/dozo-replay-kind.ts) asks the same question.
 */
export function dozoReplayableChat(
  thread: {
    botId: string | null;
    userId: string;
    groupId: string | null;
    helperBotId: string | null;
    externalConversationId: string | null;
  },
  bot: { id: string; userId: string },
  runUserId: string,
): boolean {
  return (
    !thread.groupId &&
    !thread.helperBotId &&
    !thread.externalConversationId &&
    thread.botId === bot.id &&
    thread.userId === bot.userId &&
    runUserId === bot.userId
  );
}

/**
 * How many bytes of extra frames the Space's organization may still take before the last tenth of
 * its shared space, or null where files have no limit. A look without the lock, taken once per
 * run; each write is held to it again by `holdStepFrame`.
 */
export async function stepFrameRoom(
  prisma: Pick<PrismaClient, "deploymentSettings" | "space" | "dozoPlanQuota" | "$queryRaw">,
  spaceId: string,
): Promise<number | null> {
  const limit = await sharedSpaceLimit(prisma, spaceId);
  if (!limit) return null;
  const used = await runAsSystem("an organization's files span its Spaces", () =>
    usedBytes(prisma, limit.organizationId),
  );
  return Math.floor(limit.bytes * (1 - STEP_FRAMES_FREE_SHARE)) - Number(used);
}

async function lockBotFrames(tx: Pick<PrismaClient, "$queryRaw">, botId: string) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`dozo-step-frames:${botId}`}, 0))::text AS "lock"`;
}

/**
 * Makes room for one extra frame of `bytes` and says whether it may be added, in the transaction
 * that adds its row, before adding it. Under the organization's file lock (the one every file
 * write takes, so no write passes the limit beside it) and the bot's frame lock:
 * - refused when it would take the organization into the last tenth of its shared space;
 * - the bot's pending frames of runs that ended without keeping them are removed first;
 * - past the bot's budget, the extra frames of its oldest replies go, a reply at a time, except a
 *   reply with a live replay link; refused when that still leaves no room.
 * The removed rows' stored files are the caller's to remove once the transaction commits.
 */
export async function holdStepFrame(
  tx: Prisma.TransactionClient,
  frame: { spaceId: string; botId: string; bytes: number },
): Promise<{ allowed: boolean; removed: Removed[] }> {
  const { spaceId, botId, bytes } = frame;
  return runAsSystemInTransaction(tx, "a bot's replay frames span its runs", async () => {
    const limit = await sharedSpaceLimit(tx, spaceId);
    if (limit) {
      await lockSharedSpace(tx, limit.organizationId);
      const used = await usedBytes(tx, limit.organizationId);
      const ceiling = Math.floor(limit.bytes * (1 - STEP_FRAMES_FREE_SHARE));
      if (used + BigInt(bytes) > BigInt(ceiling)) return { allowed: false, removed: [] };
    }
    await lockBotFrames(tx, botId);
    const removed = await tx.$queryRaw<Removed[]>`
      DELETE FROM artifacts a
      WHERE a."spaceId" = ${spaceId} AND a."botId" = ${botId} AND a."name" = ${STEP_FRAME_PENDING}
        AND a."runId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM runs r WHERE r."id" = a."runId" AND r."status" NOT IN (${FINISHED_RUN[0]}, ${FINISHED_RUN[1]}, ${FINISHED_RUN[2]})
        )
      RETURNING a."id", a."storageKey"`;
    const [{ used: botUsed }] = await tx.$queryRaw<[{ used: string }]>`
      SELECT COALESCE(SUM("size"), 0)::text AS "used" FROM artifacts
      WHERE "spaceId" = ${spaceId} AND "botId" = ${botId}
        AND "name" IN (${STEP_FRAME_PENDING}, ${STEP_FRAME_KEPT})`;
    let over = Number(botUsed) + bytes - STEP_FRAMES_BOT_BYTES;
    if (over <= 0) return { allowed: true, removed };
    const replies = await tx.$queryRaw<{ runId: string; bytes: string }[]>`
      SELECT a."runId", SUM(a."size")::text AS "bytes" FROM artifacts a
      WHERE a."spaceId" = ${spaceId} AND a."botId" = ${botId} AND a."name" = ${STEP_FRAME_KEPT}
        AND a."runId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          JOIN dozo_replays rp ON rp."messageId" = m."id"
          JOIN dozo_share_links l ON l."targetId" = rp."id" AND l."kind" = 'replay'
          WHERE m."runId" = a."runId" AND l."revokedAt" IS NULL AND l."expiresAt" > CURRENT_TIMESTAMP
        )
      GROUP BY a."runId" ORDER BY MIN(a."createdAt") ASC, a."runId" ASC`;
    const evicted: string[] = [];
    for (const reply of replies) {
      if (over <= 0) break;
      evicted.push(reply.runId);
      over -= Number(reply.bytes);
    }
    if (over > 0) return { allowed: false, removed };
    const gone = await tx.$queryRaw<Removed[]>`
      DELETE FROM artifacts
      WHERE "spaceId" = ${spaceId} AND "botId" = ${botId} AND "name" = ${STEP_FRAME_KEPT}
        AND "runId" = ANY(${evicted})
      RETURNING "id", "storageKey"`;
    return { allowed: true, removed: [...removed, ...gone] };
  });
}

/**
 * Settles a finished reply's extra frames under the bot's frame lock: the ones its calls link are
 * kept, and every other pending frame of the run is removed. Only the run's own pending rows are
 * touched, which no other reply links. Returns the removed rows, whose files the caller removes.
 */
export async function settleStepFrames(
  prisma: Pick<PrismaClient, "$transaction">,
  run: { spaceId: string; botId: string; runId: string; linked: string[] },
): Promise<Removed[]> {
  const { spaceId, botId, runId, linked } = run;
  return prisma.$transaction((tx) =>
    runAsSystemInTransaction(tx, "a reply's replay frames", async () => {
      await lockBotFrames(tx, botId);
      await tx.$executeRaw`
        UPDATE artifacts SET "name" = ${STEP_FRAME_KEPT}
        WHERE "spaceId" = ${spaceId} AND "botId" = ${botId} AND "runId" = ${runId}
          AND "name" = ${STEP_FRAME_PENDING} AND "id" = ANY(${linked})`;
      return tx.$queryRaw<Removed[]>`
        DELETE FROM artifacts
        WHERE "spaceId" = ${spaceId} AND "botId" = ${botId} AND "runId" = ${runId}
          AND "name" = ${STEP_FRAME_PENDING}
        RETURNING "id", "storageKey"`;
    }),
  );
}
