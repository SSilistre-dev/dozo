import type { Actor, DozoBotStats, DozoStatsCard } from "@rakazo/contracts";
import { dozoBotColor, dozoCharacterForLook } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";
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

/** Most recent runs one read looks through; a bot with more shows its numbers as "N+". */
export const STATS_RUN_WINDOW = 20_000;
/** Saved skills one read counts before it stops. */
const STATS_SKILL_CEILING = 1_000;
/** Runs that are not the person's own work: ticket work, a background helper and its relayed result. */
const NOT_OWN_SQL = Prisma.join(["tickets", "helper", "helper_result"]);

/**
 * The numbers, counted for the bot's owner only, from rows that exist:
 * - tasksFinished: finished turns the owner asked for, routine runs, tickets and helper work left out;
 * - routineRuns: finished runs the owner's routines started, so never also a task;
 * - skillsLearned: skills the owner taught and saved;
 * - daysActive: UTC days with at least one finished run of either kind.
 * Cancelled and failed runs count nowhere. One read scans the bot's newest `STATS_RUN_WINDOW` runs
 * through the `(botId, createdAt)` index plus at most `STATS_SKILL_CEILING` skills, whatever the
 * history: when the runs run past the window `more` is set and every number is a lower bound.
 * Days are UTC days, so the numbers read the same on every surface and in every time zone.
 */
export async function readBotStats(
  prisma: Reader,
  member: { spaceId: string; userId: string },
  botId: string,
): Promise<DozoBotStats> {
  const [row] = await prisma.$queryRaw<
    Array<Omit<DozoBotStats, "skillsLearned" | "more"> & { scanned: number }>
  >`
    SELECT count(*)::int AS scanned,
      (count(*) FILTER (WHERE status = 'completed' AND trigger <> 'routine'
        AND "userId" = ${member.userId} AND trigger NOT IN (${NOT_OWN_SQL})))::int
        AS "tasksFinished",
      (count(*) FILTER (WHERE status = 'completed' AND trigger = 'routine'
        AND "userId" = ${member.userId}))::int AS "routineRuns",
      count(DISTINCT ("completedAt" AT TIME ZONE 'UTC')::date) FILTER (WHERE status = 'completed'
        AND "completedAt" IS NOT NULL AND "userId" = ${member.userId}
        AND trigger NOT IN (${NOT_OWN_SQL}))::int AS "daysActive"
    FROM (
      SELECT status, trigger, "userId", "completedAt" FROM runs
      WHERE "botId" = ${botId} AND "spaceId" = ${member.spaceId}
      ORDER BY "createdAt" DESC LIMIT ${STATS_RUN_WINDOW + 1}
    ) recent`;
  const [skills] = await prisma.$queryRaw<Array<{ skillsLearned: number }>>`
    SELECT count(*)::int AS "skillsLearned" FROM (
      SELECT 1 FROM taught_skills
      WHERE "spaceId" = ${member.spaceId} AND "botId" = ${botId}
        AND "userId" = ${member.userId} AND status = 'saved'
      LIMIT ${STATS_SKILL_CEILING}
    ) saved`;
  return {
    tasksFinished: row?.tasksFinished ?? 0,
    routineRuns: row?.routineRuns ?? 0,
    skillsLearned: skills?.skillsLearned ?? 0,
    daysActive: row?.daysActive ?? 0,
    more: (row?.scanned ?? 0) > STATS_RUN_WINDOW || (skills?.skillsLearned ?? 0) >= STATS_SKILL_CEILING,
  };
}

/** How long a public card keeps its numbers in one process, so viewers never each pay for a read. */
export const STATS_CARD_CACHE_MS = 3 * 60_000;
const STATS_CARD_CACHE_MAX = 200;

/**
 * The stats card's link kind. Its payload is the whole public page: the bot's name and look and
 * the numbers, never spend, models, the Space, the owner or any text the bot wrote. Whoever opens
 * a link is served the payload read at most `STATS_CARD_CACHE_MS` ago by this process; the link
 * itself is checked on every read before this runs, so revoking still closes it at once.
 */
export function createStatsShareKind(now: () => number = Date.now): DozoShareKind {
  const cache = new Map<string, { until: number; card: DozoStatsCard }>();
  return {
    canShare: async (prisma, actor: Actor, targetId) =>
      (await ownBot(prisma, actor, targetId)) !== null,
    load: async (prisma, link): Promise<DozoStatsCard | null> => {
      const key = [link.userId, link.spaceId, link.targetId].join("\u0000");
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.card;
      cache.delete(key);
      const bot = await ownBot(prisma, { spaceId: link.spaceId }, link.targetId);
      if (!bot) return null;
      const card: DozoStatsCard = {
        name: bot.name,
        character: dozoCharacterForLook(link.targetId, bot.color),
        color: dozoBotColor(link.targetId, bot.color) ?? null,
        stats: await readBotStats(prisma, link, link.targetId),
      };
      cache.set(key, { until: now() + STATS_CARD_CACHE_MS, card });
      if (cache.size > STATS_CARD_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return card;
    },
  };
}

export const dozoStatsShareKind = createStatsShareKind();

export function dozoBotStatsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoBotStats: {
      get: authed.dozoBotStats.get.handler(async ({ context, input }) => {
        const { actor } = context;
        if (!(await ownBot(deps.prisma, actor, input.botId))) throw new IsolationError();
        return readBotStats(deps.prisma, actor, input.botId);
      }),
    },
  };
}
