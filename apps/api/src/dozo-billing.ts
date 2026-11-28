import type { ByokTier, ComputerSize } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  PLAN_LIMIT_CODES,
  planOffered,
  planOnSale,
  sandboxAllowanceHours,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { readPlanLimits, sharedSpaceUsage } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { withComputerSpecs } from "./dozo-computer-size.js";

/** A checkout was asked for a plan that has no price: the free one, which nobody pays for. */
export class PlanNotOfferedError extends ClientError {
  constructor() {
    super(
      "BAD_REQUEST",
      "This plan is free. Choose a paid plan to subscribe.",
      PLAN_LIMIT_CODES.planNotOffered,
    );
    this.name = "PlanNotOfferedError";
  }
}

/** A checkout or plan change named a paid plan that is not on sale (`DOZO_PLANS_ON_SALE`). */
export class PlanComingSoonError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "This plan isn't on sale yet.", PLAN_LIMIT_CODES.planComingSoon);
    this.name = "PlanComingSoonError";
  }
}

/**
 * The price a checkout of `tier` bills, refused unless the plan is on sale and has a price: Free is
 * told it is free, any other plan (coming soon, or not offered at all) that it is not on sale yet.
 */
export function soldPrice(tier: ByokTier, amountCents: number | null): number {
  if (amountCents !== null && planOnSale(tier)) return amountCents;
  throw BYOK_TIERS[tier].computerAllowanceCents === 0
    ? new PlanNotOfferedError()
    : new PlanComingSoonError();
}

/** The plan a plan change moves to, refused as `soldPrice` refuses it; null when there is none. */
export function soldPlan<Plan extends { tier: ByokTier; amountCents: number }>(
  plan: Plan | null,
): Plan | null {
  if (plan) soldPrice(plan.tier, plan.amountCents);
  return plan;
}

/**
 * The plan's name and shared space in use, as the billing status carries them; nothing where files
 * have no limit. Only shown, so a count that fails leaves it out and the status still answers.
 */
export async function statusSharedSpace(...read: Parameters<typeof sharedSpaceUsage>) {
  return (await bestEffort("shared space usage", sharedSpaceUsage(...read))) ?? undefined;
}

/**
 * The tier offers with each plan's computer hours as they hold: an admin's quota where one is set,
 * else the plan's terms. The allowance itself reads the same quotas, so the two never disagree.
 */
export async function withPlanHours<Offer extends { tier: ByokTier; computerHours: number }>(
  prisma: Pick<PrismaClient, "dozoPlanQuota">,
  offers: Offer[],
  hourMicros?: number,
): Promise<Offer[]> {
  const limits = await readPlanLimits(prisma);
  return offers.map((offer) => ({
    ...offer,
    computerHours: sandboxAllowanceHours(limits[offer.tier].computerAllowanceCents, hourMicros),
  }));
}

/**
 * `withPlanHours` over the offered plans (`DOZO_PLANS_OFFERED`), each with the machine this server's
 * computer provider starts, and a plan that is not on sale yet marked coming soon.
 */
export async function withPlanOffers<
  Offer extends { tier: ByokTier; computerHours: number; computerSize: ComputerSize },
>(
  prisma: Pick<PrismaClient, "dozoPlanQuota">,
  sandbox: Parameters<typeof withComputerSpecs>[1],
  offers: Offer[],
  hourMicros?: number,
) {
  const offered = offers.filter((offer) => planOffered(offer.tier));
  const sized = await withPlanHours(prisma, withComputerSpecs(offered, sandbox), hourMicros);
  return sized.map((offer) =>
    planOnSale(offer.tier) ? offer : { ...offer, comingSoon: true as const },
  );
}
