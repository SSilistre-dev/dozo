import type { Actor, DozoBotStats, DozoStatsCard } from "@rakazo/contracts";
import { dozoBotColor, dozoCharacterForLook } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { DozoShareKind } from "./dozo-share-links.js";
import type { RouterContext } from "./routes/context.js";

type Reader = Pick<PrismaClient, "$queryRaw">;

type BotRow = { name: string; color: string };

/** The bot's own row, only when it is the maker's: members of a shared Space do not share a bot's card. */
async function ownBot(
  prisma: Reader,
  member: { spaceId: string; userId?: string },
  botId: string,
): Promise<BotRow | null> {
  const [row] = await prisma.$queryRaw<BotRow[]>`
    SELECT "name", "color" FROM bots
    WHERE "id" = ${botId} AND "spaceId" = ${member.spaceId}
      AND (${member.userId ?? null}::text IS NULL OR "userId" = ${member.userId ?? null})`;
  return row ?? null;
}

/**
 * The four numbers, each from rows that exist: finished tasks and saved skills through the
 * `(spaceId, botId)` indexes, finished runs through `(botId, createdAt)`. A query reads only this
 * bot's rows, so its cost follows the bot's own history, not the account's: a bot with a million
 * runs is one index scan of them. Days are UTC days, so the number reads the same on every
 * surface and in every database time zone.
 */
export async function readBotStats(
  prisma: Reader,
  spaceId: string,
  botId: string,
): Promise<DozoBotStats> {
  const [row] = await prisma.$queryRaw<DozoBotStats[]>`
    SELECT
      (SELECT count(*)::int FROM tasks
        WHERE "spaceId" = ${spaceId} AND "botId" = ${botId} AND status = 'completed')
        AS "tasksFinished",
      (SELECT count(*)::int FROM runs
        WHERE "botId" = ${botId} AND "spaceId" = ${spaceId}
          AND status = 'completed' AND trigger = 'routine') AS "routineRuns",
      (SELECT count(*)::int FROM taught_skills
        WHERE "spaceId" = ${spaceId} AND "botId" = ${botId} AND status = 'saved')
        AS "skillsLearned",
      (SELECT count(DISTINCT ("completedAt" AT TIME ZONE 'UTC')::date)::int FROM runs
        WHERE "botId" = ${botId} AND "spaceId" = ${spaceId}
          AND status = 'completed' AND "completedAt" IS NOT NULL) AS "daysActive"`;
  return row ?? { tasksFinished: 0, routineRuns: 0, skillsLearned: 0, daysActive: 0 };
}

/**
 * The stats card's link kind. Its payload is the whole public page: the bot's name and look and
 * the four numbers, never spend, models, the Space, the owner or any text the bot wrote.
 */
export const dozoStatsShareKind: DozoShareKind = {
  canShare: async (prisma, actor: Actor, targetId) =>
    (await ownBot(prisma, actor, targetId)) !== null,
  load: async (prisma, link): Promise<DozoStatsCard | null> => {
    const bot = await ownBot(prisma, { spaceId: link.spaceId }, link.targetId);
    if (!bot) return null;
    return {
      name: bot.name,
      character: dozoCharacterForLook(link.targetId, bot.color),
      color: dozoBotColor(link.targetId, bot.color) ?? null,
      stats: await readBotStats(prisma, link.spaceId, link.targetId),
    };
  },
};

export function dozoBotStatsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoBotStats: {
      get: authed.dozoBotStats.get.handler(async ({ context, input }) => {
        const { actor } = context;
        if (!(await ownBot(deps.prisma, actor, input.botId))) throw new IsolationError();
        return readBotStats(deps.prisma, actor.spaceId, input.botId);
      }),
    },
  };
}
