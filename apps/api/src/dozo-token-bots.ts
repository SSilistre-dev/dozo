import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * Which bots an access token reaches: the ones its member made in the token's Space and has not
 * archived, and only the one when the token is for one. Another member's bot in a shared Space is
 * not among them, even though the app lets the member talk to it. The one rule for the bot API,
 * the MCP endpoint and making a token; callers read it as the token's member (`runAsTenant`).
 */
const ownBots = (actor: Actor) => ({
  spaceId: actor.spaceId,
  userId: actor.userId,
  archivedAt: null,
});

/** The ids of every bot the token reaches. */
export async function dozoTokenBotIds(
  prisma: PrismaClient,
  actor: Actor,
  onlyBotId: string | null,
): Promise<Set<string>> {
  const bots = await prisma.bot.findMany({
    where: { ...ownBots(actor), ...(onlyBotId === null ? {} : { id: onlyBotId }) },
    select: { id: true },
  });
  return new Set(bots.map((bot) => bot.id));
}

/** The bots a token can be made for, by name: the member's own, as `dozoTokenBotIds` counts them. */
export function dozoTokenOwnBots(
  prisma: PrismaClient,
  actor: Actor,
): Promise<{ id: string; name: string }[]> {
  return prisma.bot.findMany({
    where: ownBots(actor),
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Whether the token reaches `botId`; a bot it does not reach and one that does not exist look alike. */
export async function dozoTokenReachesBot(
  prisma: PrismaClient,
  actor: Actor,
  onlyBotId: string | null,
  botId: string,
): Promise<boolean> {
  if (onlyBotId !== null && onlyBotId !== botId) return false;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, ...ownBots(actor) },
    select: { id: true },
  });
  return bot !== null;
}
