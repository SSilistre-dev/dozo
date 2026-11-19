import type { DozoLedger, DozoPaymentLedger } from "@rakazo/adapters";
import type {
  ByokTier,
  DozoAdminBillingSummary,
  DozoAdminPlanCount,
  DozoAdminRevenue,
  DozoAdminRevenuePeriod,
} from "@rakazo/contracts";
import { ByokTierSchema } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  grantInForce,
  isOwnerRole,
  LIVE_ORGANIZATION,
  paidTierOf,
  runAsSystem,
  tierInForce,
} from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

export const DOZO_ADMIN_RECENT_PAYMENTS = 20;
/** A provider read is reused this long, so reloading the page does not read it again. */
export const DOZO_ADMIN_REVENUE_CACHE_MS = 60_000;
/** The subscription statuses that give the plan (`hasBillingAccess`). */
export const DOZO_ADMIN_LIVE_STATUSES = ["trialing", "active", "past_due"];
const DAY_MS = 24 * 60 * 60 * 1000;
// Chat-app contacts are internal rows with no sign-in; members are people.
const people = { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } };

/** What the summary reads of a live subscription. */
export type BillingRow = {
  organizationId: string;
  status: string | null;
  byokTier: string | null;
  byokInterval: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};
export type GrantRow = { organizationId: string; tier: string; endsAt: Date };

export interface SummaryInput {
  members: number;
  /** Subscriptions per status, every status. */
  statuses: { status: string | null; count: number }[];
  /** Subscriptions in a live status. */
  live: BillingRow[];
  /** Grants that have not ended. */
  grants: GrantRow[];
  /**
   * The organization each member owns (the one their plan is read from, as on the admin list),
   * for the members of an organization with a live subscription or a grant.
   */
  owned: Map<string, string>;
}

/**
 * Plans are counted per member, from the organization they own, so Free is every other member.
 * The plan in force is the higher of the paid tier and an unexpired grant, as everywhere else.
 * Subscription figures are counted per subscription.
 */
export function billingSummary(input: SummaryInput, now: Date): DozoAdminBillingSummary {
  const liveOf = new Map(input.live.map((row) => [row.organizationId, row]));
  const grantOf = new Map(input.grants.map((row) => [row.organizationId, row]));
  const plans = new Map<ByokTier, DozoAdminPlanCount>(
    ByokTierSchema.options.map((tier) => [
      tier,
      { tier, total: 0, monthly: 0, yearly: 0, granted: 0 },
    ]),
  );
  for (const organizationId of input.owned.values()) {
    const row = liveOf.get(organizationId);
    const paid = paidTierOf(row);
    const grant = grantInForce(grantOf.get(organizationId), now);
    const tier = tierInForce(paid, grant, now);
    if (!tier) continue;
    const count = plans.get(tier)!;
    if (tier === paid) count[row?.byokInterval === "year" ? "yearly" : "monthly"]++;
    else count.granted++;
    count.total++;
  }
  // Everyone not on a paid tier is on Free, a Free subscription included.
  const onPaidTiers = plans.get("pro")!.total + plans.get("max")!.total;
  plans.get("standard")!.total = input.members - onPaidTiers;

  const byStatus = (...statuses: string[]) =>
    input.statuses
      .filter((row) => row.status && statuses.includes(row.status))
      .reduce((sum, row) => sum + row.count, 0);
  const ending = { within7Days: 0, within30Days: 0 };
  for (const organizationId of new Set([...liveOf.keys(), ...grantOf.keys()])) {
    const row = liveOf.get(organizationId);
    // The soonest of what ends by itself: a trial, a grant, a subscription set to cancel.
    const ends = [
      row?.status === "trialing" ? row.trialEndsAt : null,
      grantInForce(grantOf.get(organizationId), now)?.endsAt,
      row?.cancelAtPeriodEnd ? row.currentPeriodEndsAt : null,
    ].flatMap((date) => (date && date > now ? [date.getTime() - now.getTime()] : []));
    const soonest = Math.min(...ends);
    if (soonest <= 7 * DAY_MS) ending.within7Days++;
    if (soonest <= 30 * DAY_MS) ending.within30Days++;
  }
  return {
    members: input.members,
    paid: byStatus("active"),
    trialing: byStatus("trialing"),
    granted: input.grants.filter((grant) => grantInForce(grant, now)).length,
    plans: [...plans.values()],
    ending,
    pastDue: byStatus("past_due", "unpaid"),
    cancelling: input.live.filter((row) => row.cancelAtPeriodEnd).length,
  };
}

/** The period's start, inclusive, and end, exclusive, in UTC months; it ends now at the latest. */
export function revenueRange(period: DozoAdminRevenuePeriod, now: Date) {
  const month = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  if (period === "thisMonth") return { from: month(0), to: now };
  if (period === "lastMonth") return { from: month(-1), to: month(0) };
  const from = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { from, to: now };
}

/**
 * Totals per currency and the failed count, only when every record was read: a partial read is
 * never shown as a total. The newest payments are shown either way; the payer is still opaque.
 */
export function revenueOf(ledger: DozoLedger) {
  const totals = new Map<string, { currency: string; paid: number; refunded: number }>();
  let failed = 0;
  for (const entry of ledger.entries) {
    if (entry.status === "failed") {
      failed++;
      continue;
    }
    const currency = entry.currency.toLowerCase();
    const total = totals.get(currency) ?? { currency, paid: 0, refunded: 0 };
    total[entry.status === "paid" ? "paid" : "refunded"] += entry.amount;
    totals.set(currency, total);
  }
  return {
    totals: ledger.partial ? null : [...totals.values()],
    failed: ledger.partial ? null : failed,
    unclassified: ledger.unclassified,
    recent: ledger.entries.slice(0, DOZO_ADMIN_RECENT_PAYMENTS),
  };
}

/**
 * The billing summary, counted from the deployment's own records. The admin plans page counts its
 * members from this too, so the two pages never disagree. Run it as system work: it crosses tenants.
 */
export async function readBillingSummary(prisma: PrismaClient) {
  const now = new Date();
  const [members, statuses, live, grants] = await Promise.all([
    prisma.user.count({ where: people }),
    prisma.billingAccount.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.billingAccount.findMany({
      where: { status: { in: DOZO_ADMIN_LIVE_STATUSES } },
      select: {
        organizationId: true,
        status: true,
        byokTier: true,
        byokInterval: true,
        trialEndsAt: true,
        currentPeriodEndsAt: true,
        cancelAtPeriodEnd: true,
      },
    }),
    prisma.dozoPlanGrant.findMany({
      where: { endsAt: { gt: now } },
      select: { organizationId: true, tier: true, endsAt: true },
    }),
  ]);
  // The members of those organizations, then the organization each of them owns: the oldest
  // live one they own, as `ownedOrganizationId` reads it for the admin list.
  const organizations = [...new Set([...live, ...grants].map((row) => row.organizationId))];
  const inThem = await prisma.member.findMany({
    where: { organizationId: { in: organizations }, user: people },
    select: { userId: true },
    distinct: ["userId"],
  });
  const memberships = await prisma.member.findMany({
    where: { userId: { in: inThem.map((row) => row.userId) }, organization: LIVE_ORGANIZATION },
    orderBy: { createdAt: "asc" },
    select: { userId: true, organizationId: true, role: true },
  });
  const owned = new Map<string, string>();
  for (const membership of memberships)
    if (isOwnerRole(membership.role) && !owned.has(membership.userId))
      owned.set(membership.userId, membership.organizationId);
  return billingSummary(
    {
      members,
      statuses: statuses.map((row) => ({ status: row.status, count: row._count._all })),
      live,
      grants,
      owned,
    },
    now,
  );
}

/**
 * The admin billing page: plans counted from the deployment's own records, and, when a payment
 * provider is configured, what it was paid. Refused unless the caller is a deployment admin.
 */
export function dozoAdminBillingRoutes(ctx: RouterContext, ledger: DozoPaymentLedger | undefined) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    return next();
  });
  const cache = new Map<
    DozoAdminRevenuePeriod,
    { until: number; value: Promise<DozoAdminRevenue> }
  >();

  async function readRevenue(source: DozoPaymentLedger, period: DozoAdminRevenuePeriod) {
    const accounts = await runAsSystem("read billing accounts for the admin page", () =>
      prisma.billingAccount.findMany({
        select: { customerId: true, organizationId: true, subscriptionId: true },
      }),
    );
    const { totals, failed, unclassified, recent } = revenueOf(
      await source.read(revenueRange(period, new Date()), {
        customers: new Set(accounts.map((account) => account.customerId)),
        subscriptions: new Set(accounts.flatMap((account) => account.subscriptionId ?? [])),
      }),
    );
    const organizationOf = new Map(accounts.map((row) => [row.customerId, row.organizationId]));
    const organizations = [
      ...new Set(recent.flatMap((entry) => organizationOf.get(entry.customerId) ?? [])),
    ];
    const owners = await runAsSystem("find payers for the admin page", () =>
      prisma.member.findMany({
        where: { organizationId: { in: organizations } },
        orderBy: { createdAt: "asc" },
        select: { organizationId: true, role: true, user: { select: { id: true, email: true } } },
      }),
    );
    const ownerOf = new Map<string, { id: string; email: string }>();
    for (const owner of owners)
      if (isOwnerRole(owner.role) && !ownerOf.has(owner.organizationId))
        ownerOf.set(owner.organizationId, owner.user);
    return {
      totals,
      failed,
      unclassified,
      payments: recent.map((entry) => ({
        member: ownerOf.get(organizationOf.get(entry.customerId) ?? "") ?? null,
        amount: entry.amount,
        currency: entry.currency.toLowerCase(),
        at: entry.at.toISOString(),
        status: entry.status,
      })),
    };
  }

  return {
    summary: admin.dozoAdmin.billing.summary.handler(() =>
      runAsSystem("count plans for the admin page", () => readBillingSummary(prisma)),
    ),

    revenue: admin.dozoAdmin.billing.revenue.handler(async ({ input }) => {
      if (!ledger) return null;
      const cached = cache.get(input.period);
      if (cached && cached.until > Date.now()) return cached.value;
      const value = readRevenue(ledger, input.period);
      cache.set(input.period, { until: Date.now() + DOZO_ADMIN_REVENUE_CACHE_MS, value });
      // A failed read is not kept: the next load asks again.
      value.catch(() => cache.delete(input.period));
      return value;
    }),
  };
}
