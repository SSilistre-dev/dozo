import type { ByokTier, DozoAdminPlan } from "@rakazo/contracts";
import type { PlanGrant, Prisma, PrismaClient } from "@rakazo/db";
import {
  DOZO_PLAN_GRANT_SELECT,
  grantInForce,
  isOwnerRole,
  LIVE_ORGANIZATION,
  paidTierOf,
  tierInForce,
} from "@rakazo/db";
import { statusPlanEnd } from "./dozo-plan-end.js";

/** What the admin page reads of an account's own organization to tell its plan and its ends. */
export const DOZO_ADMIN_ORGANIZATION_SELECT = {
  id: true,
  billing: {
    select: {
      status: true,
      byokTier: true,
      trialEndsAt: true,
      currentPeriodEndsAt: true,
      cancelAtPeriodEnd: true,
    },
  },
  dozoPlanGrant: { select: DOZO_PLAN_GRANT_SELECT },
  modelCredits: { select: { byokFreeUntil: true } },
} as const;

export type DozoAdminOrganization = {
  id: string;
  billing: {
    status: string | null;
    byokTier: string | null;
    trialEndsAt: Date | null;
    currentPeriodEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  dozoPlanGrant: PlanGrant | null;
  modelCredits: { byokFreeUntil: Date | null } | null;
};

/**
 * Each account's own organization, in one read for every account listed: `ownedOrganizationId`
 * answers for one account, and calling it per account is the query per row this replaces. The
 * same rule, from its own parts: the oldest live organization the account owns (a test holds the
 * two equal). An account without one is absent.
 */
export async function ownedOrganizations(
  prisma: Pick<PrismaClient, "member">,
  userIds: string[],
): Promise<Map<string, string>> {
  const owned = new Map<string, string>();
  if (userIds.length === 0) return owned;
  const memberships = await prisma.member.findMany({
    where: { userId: { in: userIds }, organization: LIVE_ORGANIZATION },
    select: { userId: true, organizationId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  for (const membership of memberships)
    if (!owned.has(membership.userId) && isOwnerRole(membership.role))
      owned.set(membership.userId, membership.organizationId);
  return owned;
}

/**
 * The plan in force (`tierInForce`) and when it ends or renews, as the member's own billing status
 * tells it (`statusPlanEnd`), with what keeps it until then: the grant when its date is the end,
 * else the subscription or its trial. On Free with nothing ending, a running free period. Run as
 * system work by the caller.
 */
export function planOfOrganization(
  organization: DozoAdminOrganization | null | undefined,
  now: Date,
): DozoAdminPlan {
  const billing = organization?.billing;
  const grant = grantInForce(organization?.dozoPlanGrant, now);
  const tier = tierInForce(paidTierOf(billing), organization?.dozoPlanGrant, now) ?? "standard";
  const end = statusPlanEnd(billing, organization?.dozoPlanGrant, now);
  const freeUntil = organization?.modelCredits?.byokFreeUntil;
  const ends = end
    ? {
        ...end,
        source:
          grant && !end.renews && end.at === grant.endsAt.toISOString()
            ? ("granted" as const)
            : billing?.status === "trialing"
              ? ("trial" as const)
              : ("subscription" as const),
      }
    : tier === "standard" && freeUntil && freeUntil > now
      ? { source: "freeMonth" as const, at: freeUntil.toISOString(), renews: false }
      : null;
  return { tier, grantedUntil: grant?.endsAt.toISOString() ?? null, ends };
}

/**
 * The plan of every listed account, in two reads whatever their number. An account with no
 * organization of its own is on Free. Run as system work by the caller.
 */
export async function plansOf(
  prisma: Pick<PrismaClient, "member" | "organization">,
  userIds: string[],
  now: Date,
) {
  const owned = await ownedOrganizations(prisma, userIds);
  const organizations: DozoAdminOrganization[] = owned.size
    ? await prisma.organization.findMany({
        where: { id: { in: [...new Set(owned.values())] } },
        select: DOZO_ADMIN_ORGANIZATION_SELECT,
      })
    : [];
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  return (userId: string): DozoAdminPlan => {
    const organizationId = owned.get(userId);
    return planOfOrganization(organizationId ? byId.get(organizationId) : undefined, now);
  };
}

/**
 * The billing statuses `hasBillingAccess` lets through, for a database filter; a test holds this
 * list to the function over every status a subscription can have.
 */
export const LIVE_BILLING_STATUSES = ["trialing", "active", "past_due"];

/** An organization whose plan in force is `tier` or above it, now: the rule of `tierInForce`. */
function atLeast(tier: "pro" | "max", now: Date): Prisma.OrganizationWhereInput {
  const tiers = tier === "pro" ? ["pro", "max"] : ["max"];
  return {
    OR: [
      { billing: { status: { in: LIVE_BILLING_STATUSES }, byokTier: { in: tiers } } },
      { dozoPlanGrant: { tier: { in: tiers }, endsAt: { gt: now } } },
    ],
  };
}

/** An account that owns a live organization matching `organization`. */
function owns(organization: Prisma.OrganizationWhereInput): Prisma.UserWhereInput {
  return {
    members: {
      some: {
        role: { contains: "owner" },
        organization: { AND: [LIVE_ORGANIZATION, organization] },
      },
    },
  };
}

/**
 * Narrows the account list to the accounts on `tier` now, as one condition of the list's own
 * query. It looks at the live organizations an account owns: nearly every account owns one, its
 * own; one that owns several counts at its highest, where the list shows its oldest.
 */
export function onTier(tier: ByokTier, now: Date): Prisma.UserWhereInput {
  if (tier === "max") return owns(atLeast("max", now));
  if (tier === "pro")
    return { AND: [owns(atLeast("pro", now)), { NOT: owns(atLeast("max", now)) }] };
  return { NOT: owns(atLeast("pro", now)) };
}
