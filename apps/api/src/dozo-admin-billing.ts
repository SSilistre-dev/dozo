import type { DozoLedgerEntry, DozoPaymentLedger } from "@rakazo/adapters";
import type {
  ByokTier,
  DozoAdminBillingSummary,
  DozoAdminRevenue,
  DozoAdminRevenuePeriod,
} from "@rakazo/contracts";
import { ByokTierSchema } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import {
  grantInForce,
  hasBillingAccess,
  isOwnerRole,
  paidTierOf,
  runAsSystem,
  tierInForce,
} from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

export const DOZO_ADMIN_RECENT_PAYMENTS = 20;
/** A provider read is reused this long, so reloading the page does not read it again. */
export const DOZO_ADMIN_REVENUE_CACHE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the summary reads of one organization's subscription. */
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

/**
 * Counts plans by organization: an account without a subscription or a grant is on Free. The plan
 * in force is the higher of the paid tier and an unexpired grant, as everywhere else.
 */
export function billingSummary(
  members: number,
  billing: BillingRow[],
  grants: GrantRow[],
  now: Date,
): DozoAdminBillingSummary {
  const plans = new Map(
    ByokTierSchema.options.map((tier) => [
      tier,
      { tier, total: 0, monthly: 0, yearly: 0, granted: 0 },
    ]),
  );
  const billingOf = new Map(billing.map((row) => [row.organizationId, row]));
  const grantOf = new Map(grants.map((row) => [row.organizationId, row]));
  const summary = {
    members,
    paid: 0,
    trialing: 0,
    granted: 0,
    ending: { within7Days: 0, within30Days: 0 },
    pastDue: 0,
    cancelling: 0,
  };
  for (const organizationId of new Set([...billingOf.keys(), ...grantOf.keys()])) {
    const row = billingOf.get(organizationId);
    const grant = grantInForce(grantOf.get(organizationId), now);
    const paid = paidTierOf(row);
    const tier: ByokTier = tierInForce(paid, grant, now) ?? "standard";
    const live = hasBillingAccess(row?.status ?? null);
    const count = plans.get(tier)!;
    if (paid === tier) {
      count[row?.byokInterval === "year" ? "yearly" : "monthly"]++;
      count.total++;
    } else if (grant) {
      count.granted++;
      count.total++;
    }
    if (row?.status === "active") summary.paid++;
    if (row?.status === "trialing") summary.trialing++;
    if (row?.status === "past_due" || row?.status === "unpaid") summary.pastDue++;
    if (live && row?.cancelAtPeriodEnd) summary.cancelling++;
    if (grant) summary.granted++;
    // The soonest of what ends by itself: a trial, a grant, a subscription set to cancel.
    const ends = [
      row?.status === "trialing" ? row.trialEndsAt : null,
      grant?.endsAt,
      live && row?.cancelAtPeriodEnd ? row.currentPeriodEndsAt : null,
    ].flatMap((date) => (date && date > now ? [date.getTime() - now.getTime()] : []));
    const soonest = Math.min(...ends);
    if (soonest <= 7 * DAY_MS) summary.ending.within7Days++;
    if (soonest <= 30 * DAY_MS) summary.ending.within30Days++;
  }
  const free = plans.get("standard")!;
  free.total += Math.max(
    0,
    members - [...plans.values()].reduce((sum, count) => sum + count.total, 0),
  );
  return { ...summary, plans: [...plans.values()] };
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

/** Totals per currency, the failed count and the newest payments; the payer is still opaque. */
export function revenueOf(entries: DozoLedgerEntry[]) {
  const totals = new Map<string, { currency: string; paid: number; refunded: number }>();
  let failed = 0;
  for (const entry of entries) {
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
    totals: [...totals.values()],
    failed,
    recent: entries.slice(0, DOZO_ADMIN_RECENT_PAYMENTS),
  };
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
      prisma.billingAccount.findMany({ select: { customerId: true, organizationId: true } }),
    );
    const ledger = await source.read(
      revenueRange(period, new Date()),
      new Set(accounts.map((account) => account.customerId)),
    );
    const { totals, failed, recent } = revenueOf(ledger.entries);
    const organizationOf = new Map(accounts.map((row) => [row.customerId, row.organizationId]));
    const organizations = [
      ...new Set(recent.flatMap((entry) => organizationOf.get(entry.customerId ?? "") ?? [])),
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
      partial: ledger.partial,
      payments: recent.map((entry) => ({
        member: ownerOf.get(organizationOf.get(entry.customerId ?? "") ?? "") ?? null,
        amount: entry.amount,
        currency: entry.currency.toLowerCase(),
        at: entry.at.toISOString(),
        status: entry.status,
      })),
    };
  }

  return {
    summary: admin.dozoAdmin.billing.summary.handler(() =>
      runAsSystem("count plans for the admin page", async () => {
        const now = new Date();
        const [members, billing, grants] = await Promise.all([
          prisma.user.count({ where: { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } } }),
          prisma.billingAccount.findMany({
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
        return billingSummary(members, billing, grants, now);
      }),
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
