import type { DozoCacheSavings } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { billingAccountForOrganization, hasBillingAccess, organizationForMember } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

type CacheSums = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * The share of input read from the cache. A record's input count is uncached input only, and its
 * cache reads and writes come on top (a one-hour write is part of the writes), so all three make
 * the input. Null without any input. The percent rounds down, so 100 means every token.
 */
export function cacheSavings(sums: CacheSums, since: Date): DozoCacheSavings | null {
  const cacheReadTokens = sums.cacheReadTokens ?? 0;
  const inputTokens = (sums.inputTokens ?? 0) + cacheReadTokens + (sums.cacheWriteTokens ?? 0);
  if (inputTokens <= 0) return null;
  return {
    since: since.toISOString(),
    inputTokens,
    cacheReadTokens,
    cacheReadPercent: Math.floor((cacheReadTokens * 100) / inputTokens),
  };
}

/**
 * Where the member's current period began: the live subscription's billing period of the
 * organization that pays for their work here, else the calendar month in UTC, as the computer
 * allowance counts it.
 */
export async function usagePeriodStart(
  prisma: PrismaClient,
  member: { spaceId: string; userId: string },
  now = new Date(),
): Promise<Date> {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const organization = await organizationForMember(prisma, member);
  if (!organization) return month;
  const billing = await billingAccountForOrganization(prisma, organization.organizationId);
  const start = billing?.currentPeriodStartsAt;
  const live = hasBillingAccess(billing?.status ?? null);
  return live && start && start <= now ? start : month;
}

/** The cache share of the caller's own usage in the current Space, as the Usage settings count it. */
export function dozoUsageRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoUsage: {
      cacheSavings: authed.dozoUsage.cacheSavings.handler(async ({ context }) => {
        const member = { spaceId: context.actor.spaceId, userId: context.actor.userId };
        const since = await usagePeriodStart(deps.prisma, member);
        const result = await deps.prisma.usageRecord.aggregate({
          where: { ...member, createdAt: { gte: since } },
          _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
        });
        return cacheSavings(result._sum, since);
      }),
    },
  };
}
