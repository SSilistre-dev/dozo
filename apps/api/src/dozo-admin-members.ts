import type { ByokTier, DozoAdminPlan, DozoAdminPlanEnd } from "@rakazo/contracts";
import type { PlanGrant, PrismaClient } from "@rakazo/db";
import {
  DOZO_PLAN_GRANT_SELECT,
  grantInForce,
  isOwnerRole,
  LIVE_ORGANIZATION,
  paidTierOf,
  tierInForce,
} from "@rakazo/db";

const DAY_MS = 24 * 60 * 60 * 1000;

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

type Db = Pick<PrismaClient, "member" | "organization">;

/**
 * Each account's own organization, picked as `ownedOrganizationId` picks it (the oldest live one
 * it owns), in one read for every account. An account without one is absent.
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

function planEnd(
  source: DozoAdminPlanEnd["source"],
  at: Date | null | undefined,
  now: Date,
  renews = false,
): DozoAdminPlanEnd | null {
  if (!at || at <= now) return null;
  const daysLeft = Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
  return { source, at: at.toISOString(), daysLeft, renews };
}

/**
 * The plan in force, the higher of a live subscription's tier and an unexpired grant's, and the
 * end of what keeps it: the subscription's period (or its trial), else the grant, else on Free a
 * running free period. Run as system work by the caller.
 */
export function planOfOrganization(
  organization: DozoAdminOrganization | null | undefined,
  now: Date,
): DozoAdminPlan {
  const billing = organization?.billing;
  const paid = paidTierOf(billing);
  const grant = grantInForce(organization?.dozoPlanGrant, now);
  const tier = tierInForce(paid, organization?.dozoPlanGrant, now) ?? "standard";
  const subscription =
    paid === tier && billing
      ? billing.status === "trialing"
        ? planEnd("trial", billing.trialEndsAt ?? billing.currentPeriodEndsAt, now)
        : planEnd("subscription", billing.currentPeriodEndsAt, now, !billing.cancelAtPeriodEnd)
      : null;
  const ends =
    subscription ??
    (grant?.tier === tier ? planEnd("granted", grant.endsAt, now) : null) ??
    (tier === "standard"
      ? planEnd("freeMonth", organization?.modelCredits?.byokFreeUntil, now)
      : null);
  return { tier, grantedUntil: grant?.endsAt.toISOString() ?? null, ends };
}

/**
 * The plan of every listed account, in two reads whatever their number. An account with no
 * organization of its own is on Free. Run as system work by the caller.
 */
export async function plansOf(prisma: Db, userIds: string[], now: Date) {
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
 * Narrows the account list to the accounts on `tier` now, in three reads. Only organizations with
 * a subscription or an unexpired grant can be above Free, so those are read and their owners
 * judged by the same rule as the list; Free is everyone else. Run as system work by the caller.
 */
export async function onTier(
  prisma: Db,
  tier: ByokTier,
  now: Date,
): Promise<{ id: { in: string[] } | { notIn: string[] } }> {
  const candidates: DozoAdminOrganization[] = await prisma.organization.findMany({
    where: {
      OR: [{ billing: { status: { not: null } } }, { dozoPlanGrant: { endsAt: { gt: now } } }],
    },
    select: DOZO_ADMIN_ORGANIZATION_SELECT,
  });
  const tierOf = new Map(
    candidates.map((organization) => [organization.id, planOfOrganization(organization, now).tier]),
  );
  const paying = [...tierOf].flatMap(([id, paid]) => (paid === "standard" ? [] : [id]));
  const owners = paying.length
    ? await prisma.member.findMany({
        where: { organizationId: { in: paying } },
        select: { userId: true, role: true },
      })
    : [];
  const userIds = [
    ...new Set(owners.flatMap((owner) => (isOwnerRole(owner.role) ? [owner.userId] : []))),
  ];
  // An owner of a paying organization may own an older one too, which is the one that counts.
  const owned = await ownedOrganizations(prisma, userIds);
  const above = (wanted: (paid: ByokTier) => boolean) =>
    userIds.filter((userId) => {
      const paid = tierOf.get(owned.get(userId) ?? "");
      return paid !== undefined && wanted(paid);
    });
  if (tier === "standard") return { id: { notIn: above((paid) => paid !== "standard") } };
  return { id: { in: above((paid) => paid === tier) } };
}
