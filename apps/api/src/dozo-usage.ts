import type { DozoCacheSavings } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  monthlyBillingPeriod,
  organizationForMember,
} from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

type CacheSums = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * The share of input read from the cache. A record's input count is uncached input only, and its
 * cache reads and writes come on top (a one-hour write is part of the writes), so all three make
 * the input. The sums cover measured records only (see `MEASURED`). Null without any input. The
 * percent rounds down, so 100 means every token.
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
 * The records the share counts. A record whose input or cache reads were not measured is left
 * out, rather than counted as reads of zero, which would lower the share by input nobody knows
 * the reads of. Unlike the Usage table's totals, which read as unknown when any record lacks a
 * count, the share stays shown over the records that have one: a provider that never reports
 * cache reads would otherwise hide it for good. A provider that caches without a write step
 * reports no writes, so a missing write count is no writes.
 */
const MEASURED = { inputTokens: { not: null }, cacheReadTokens: { not: null } } as const;

/**
 * Where the member's current period began: the month of the billing period of the organization
 * that pays for their work here, as the computer allowance counts it.
 */
export async function usagePeriodStart(
  prisma: PrismaClient,
  member: { spaceId: string; userId: string },
  now = new Date(),
): Promise<Date> {
  const organization = await organizationForMember(prisma, member);
  const billing = organization
    ? await billingAccountForOrganization(prisma, organization.organizationId)
    : null;
  return monthlyBillingPeriod(billing, now).since;
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
          where: { ...member, ...MEASURED, createdAt: { gte: since } },
          _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
        });
        return cacheSavings(result._sum, since);
      }),
    },
  };
}
