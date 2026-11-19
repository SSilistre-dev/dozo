import { ByokTierSchema } from "@rakazo/contracts";
import type { PlanGrant } from "@rakazo/db";
import { grantInForce, hasBillingAccess, paidTierOf } from "@rakazo/db";

type Subscription = {
  status: string | null;
  byokTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

type PlanEnd = { at: string; renews: boolean };

const rank = (tier: string) => ByokTierSchema.options.indexOf(ByokTierSchema.parse(tier));

/** When a live subscription's current period, or its trial, is over, and whether it goes on. */
function subscriptionEnd(account: Subscription): PlanEnd | null {
  const at =
    account.status === "trialing"
      ? (account.trialEndsAt ?? account.currentPeriodEndsAt)
      : account.currentPeriodEndsAt;
  return at ? { at: at.toISOString(), renews: !account.cancelAtPeriodEnd } : null;
}

/**
 * When the plan in force ends or renews, as the billing status carries it; undefined when it has
 * no end. The plan in force is the one `tierInForce` picks: a grant above the subscription ends on
 * its own date; a subscription above the grant renews or ends with its period; when both give the
 * same tier the plan lasts as long as either. Without either, a running free period ends.
 */
export function statusPlanEnd(
  account: Subscription | null | undefined,
  freeUntil: Date | null,
  grant: PlanGrant | null | undefined,
  now = new Date(),
): PlanEnd | undefined {
  const granted = grantInForce(grant, now);
  const live = account && hasBillingAccess(account.status) ? subscriptionEnd(account) : null;
  const grantEnd = granted && { at: granted.endsAt.toISOString(), renews: false };
  if (grantEnd && live) {
    const order = rank(granted.tier) - rank(paidTierOf(account) ?? "standard");
    if (order > 0) return grantEnd;
    if (order < 0 || live.renews) return live;
    return live.at > grantEnd.at ? live : grantEnd;
  }
  const end = grantEnd ?? live ?? (freeUntil && { at: freeUntil.toISOString(), renews: false });
  return end ?? undefined;
}
