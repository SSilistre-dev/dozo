import type { ByokTier, PlanEnd } from "@rakazo/contracts";
import { BYOK_TIERS, ByokTierSchema } from "@rakazo/contracts";
import type { PlanGrant } from "@rakazo/db";
import { grantInForce, hasBillingAccess, paidTierOf } from "@rakazo/db";

type Subscription = {
  status: string | null;
  byokTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

const rank = (tier: ByokTier) => ByokTierSchema.options.indexOf(tier);

/** When a live subscription's period, or its trial, is over and whether it goes on; null once past. */
function subscriptionEnd(account: Subscription, now: Date): PlanEnd | null {
  const at =
    account.status === "trialing"
      ? (account.trialEndsAt ?? account.currentPeriodEndsAt)
      : account.currentPeriodEndsAt;
  return at && at > now ? { at: at.toISOString(), renews: !account.cancelAtPeriodEnd } : null;
}

/**
 * When the plan in force ends or renews, as the billing status carries it; undefined when it has
 * no end still to come. The plan in force is the one `tierInForce` picks: a grant above the
 * subscription ends on its own date and the subscription's plan follows (`fallsTo`); a
 * subscription above the grant renews or ends with its period; when both give the same tier the
 * plan lasts as long as either.
 *
 * The paid tier is `paidTierOf`, which an unpaid or paused subscription does not count, as the
 * limits do not; the status's `byokTier` also names such a subscription's tier, but only as a label.
 */
export function statusPlanEnd(
  account: Subscription | null | undefined,
  grant: PlanGrant | null | undefined,
  now = new Date(),
): PlanEnd | undefined {
  const granted = grantInForce(grant, now);
  const paid = paidTierOf(account);
  const live = account && hasBillingAccess(account.status) ? subscriptionEnd(account, now) : null;
  if (!granted) return live ?? undefined;
  const grantEnd = { at: granted.endsAt.toISOString(), renews: false };
  const order = rank(granted.tier) - rank(paid ?? "standard");
  if (order > 0)
    return paid
      ? { ...grantEnd, fallsTo: { from: BYOK_TIERS[granted.tier].name, to: BYOK_TIERS[paid].name } }
      : grantEnd;
  if (order < 0 || live?.renews) return live ?? undefined;
  return live && live.at > grantEnd.at ? live : grantEnd;
}
