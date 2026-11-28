import type { Actor, DozoBotDefinition } from "@rakazo/contracts";
import { DozoBotDefinitionSchema, dozoBotSharePublic } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readJsonColumn } from "@rakazo/db";
import type { DozoShareKind, DozoShareTarget } from "./dozo-share-links.js";

/** Only the bot's owner shares it, and only while it is not archived unless `archived` says so. */
export async function ownsBot(
  prisma: Pick<PrismaClient, "bot">,
  actor: Actor,
  botId: string,
  options: { archived?: boolean } = {},
): Promise<boolean> {
  const bot = await prisma.bot.findFirst({
    where: {
      id: botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(options.archived ? {} : { archivedAt: null }),
    },
    select: { id: true },
  });
  return Boolean(bot);
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
  canShare: (prisma, actor, targetId) => ownsBot(prisma, actor, targetId),
  load: async (prisma, link) => {
    const definition = await readBotShare(prisma, link);
    return definition && dozoBotSharePublic(definition);
  },
};
