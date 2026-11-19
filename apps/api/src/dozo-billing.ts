import type { ByokTier } from "@rakazo/contracts";
import { PLAN_LIMIT_CODES, sandboxAllowanceHours } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { readPlanLimits, sharedSpaceUsage } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

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
  prisma: object,
  offers: Offer[],
): Promise<Offer[]> {
  const limits = await readPlanLimits(prisma);
  return offers.map((offer) => ({
    ...offer,
    computerHours: sandboxAllowanceHours(limits[offer.tier].computerAllowanceCents),
  }));
}
