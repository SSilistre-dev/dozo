import type { ByokTier } from "@rakazo/contracts";
import { BYOK_TIERS, ByokTierSchema } from "@rakazo/contracts";
import { hasBillingAccess } from "./billing.js";
import type { PrismaClient } from "./client.js";
import type { PlanLimitsByTier } from "./dozo-plan-quotas.js";

/**
 * A plan an admin gave an organization by hand, kept beside its subscription and never written by
 * the subscription sync. It counts only until `endsAt`: expiry is the comparison in `tierInForce`,
 * so nothing runs when a grant ends and nothing has to be undone.
 */
export const DOZO_PLAN_GRANT_SELECT = { tier: true, endsAt: true } as const;

export type PlanGrant = { tier: string; endsAt: Date };

/** The tiers an admin can grant: Free is what everyone has. */
export type GrantTier = Exclude<ByokTier, "standard">;

/**
 * The tier a subscription pays for while it is live, else null. A subscription on credits has no
 * own-key tier, so it is null too.
 */
export function paidTierOf(
  billing: { status: string | null; byokTier: string | null } | null | undefined,
): ByokTier | null {
  return hasBillingAccess(billing?.status ?? null)
    ? (ByokTierSchema.safeParse(billing?.byokTier).data ?? null)
    : null;
}

/**
 * The grant as it counts now, or null: it counts only while `endsAt` is after `now`, and only for a
 * tier an admin can grant (a stored value that is not one counts as no grant). The one place the
 * grant's date is compared.
 */
export function grantInForce(
  grant: PlanGrant | null | undefined,
  now = new Date(),
): { tier: GrantTier; endsAt: Date } | null {
  if (!grant || grant.endsAt <= now) return null;
  const tier = ByokTierSchema.safeParse(grant.tier).data;
  return tier && tier !== "standard" ? { tier, endsAt: grant.endsAt } : null;
}

/**
 * The tier in force: the higher of the paid one and an unexpired grant's. The one place that picks
 * the higher tier, so every reader of the plan agrees.
 */
export function tierInForce(
  paid: ByokTier | null,
  grant: PlanGrant | null | undefined,
  now = new Date(),
): ByokTier | null {
  const granted = grantInForce(grant, now)?.tier;
  if (!granted) return paid;
  if (!paid) return granted;
  const rank = (tier: ByokTier) => ByokTierSchema.options.indexOf(tier);
  return rank(granted) > rank(paid) ? granted : paid;
}

/**
 * The computer allowance in cents an unexpired grant gives; 0 without one. `limits` are the plans'
 * limits as `readPlanLimits` reads them, the admin's quotas included; without them, the terms.
 */
export function grantedAllowanceCents(
  grant: PlanGrant | null | undefined,
  now = new Date(),
  limits?: PlanLimitsByTier,
): number {
  const granted = grantInForce(grant, now);
  if (!granted) return 0;
  return (limits ?? BYOK_TIERS)[granted.tier].computerAllowanceCents;
}

/** The organization's grant, expired or not; `tierInForce` decides whether it counts. */
export function planGrantOf(
  prisma: Pick<PrismaClient, "dozoPlanGrant">,
  organizationId: string,
): Promise<PlanGrant | null> {
  return prisma.dozoPlanGrant.findUnique({
    where: { organizationId },
    select: DOZO_PLAN_GRANT_SELECT,
  });
}

/** Gives the organization the tier until `endsAt`, replacing any grant it has. */
export async function setPlanGrant(
  prisma: Pick<PrismaClient, "dozoPlanGrant">,
  input: {
    organizationId: string;
    tier: GrantTier;
    endsAt: Date;
    grantedById: string;
    note?: string | undefined;
  },
): Promise<void> {
  const { organizationId, ...grant } = input;
  const data = { ...grant, note: grant.note ?? null };
  await prisma.dozoPlanGrant.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: data,
  });
}

/** Ends the organization's grant now. False when it had none. */
export async function revokePlanGrant(
  prisma: Pick<PrismaClient, "dozoPlanGrant">,
  organizationId: string,
): Promise<boolean> {
  const { count } = await prisma.dozoPlanGrant.deleteMany({ where: { organizationId } });
  return count > 0;
}
