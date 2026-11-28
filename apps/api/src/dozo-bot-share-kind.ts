import type { Actor, DozoBotDefinition } from "@rakazo/contracts";
import {
  DOZO_BOT_SHARE_KIND,
  DozoBotDefinitionSchema,
  dozoBotSharePublic,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readJsonColumn } from "@rakazo/db";
import type { DozoShareKind, DozoShareTarget } from "./dozo-share-links.js";

/** The owner's bot, archived or not; null for anyone else's or one that is gone. */
async function ownBot(prisma: Pick<PrismaClient, "bot">, actor: Actor, botId: string) {
  return prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { archivedAt: true },
  });
}

/** Only the bot's owner shares it, and only while it is not archived unless `archived` says so. */
export async function ownsBot(
  prisma: Pick<PrismaClient, "bot">,
  actor: Actor,
  botId: string,
  options: { archived?: boolean } = {},
): Promise<boolean> {
  const bot = await ownBot(prisma, actor, botId);
  return Boolean(bot && (options.archived || !bot.archivedAt));
}

/** Revokes every link the owner made to the bot and deletes what they published for it. */
export async function closeBotShare(
  db: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  botId: string,
): Promise<void> {
  await db.$queryRaw`
    UPDATE dozo_share_links SET "revokedAt" = CURRENT_TIMESTAMP
    WHERE "kind" = ${DOZO_BOT_SHARE_KIND} AND "targetId" = ${botId} AND "userId" = ${actor.userId}
      AND "spaceId" = ${actor.spaceId} AND "revokedAt" IS NULL
    RETURNING "id"`;
  await db.$queryRaw`
    DELETE FROM dozo_bot_shares
    WHERE "botId" = ${botId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    RETURNING "botId"`;
}

/**
 * The definition the owner published for the link's bot, or null when there is none. A stored one
 * that no longer passes the limits shows nothing, with a warning.
 */
export async function readBotShare(
  prisma: Pick<PrismaClient, "$queryRaw">,
  link: DozoShareTarget,
): Promise<DozoBotDefinition | null> {
  const [row] = await prisma.$queryRaw<{ definition: unknown }[]>`
    SELECT "definition" FROM dozo_bot_shares
    WHERE "botId" = ${link.targetId} AND "userId" = ${link.userId} AND "spaceId" = ${link.spaceId}`;
  if (!row) return null;
  const at = { table: "dozo_bot_shares", column: "definition", id: link.targetId };
  return readJsonColumn(DozoBotDefinitionSchema.nullable(), row.definition, at, { fallback: null });
}

/**
 * A bot's published definition. The link names the bot; what it shows is the snapshot taken when
 * the owner confirmed, and only its public part: avatar, name, the first lines of the
 * instructions and the routine names.
 */
export const botShareKind: DozoShareKind = {
  // Only the feature's reviewed publish makes one: the generic create would skip the review.
  featureOnly: true,
  /**
   * Archiving is upstream's own route, which no fork code sees, so the first read that finds the
   * bot archived closes its share for good: un-archiving never reopens a forgotten link.
   */
  canShare: async (prisma, actor, targetId) => {
    const bot = await ownBot(prisma, actor, targetId);
    if (bot?.archivedAt) await closeBotShare(prisma, actor, targetId);
    return Boolean(bot && !bot.archivedAt);
  },
  load: async (prisma, link) => {
    const definition = await readBotShare(prisma, link);
    return definition && dozoBotSharePublic(definition);
  },
};
