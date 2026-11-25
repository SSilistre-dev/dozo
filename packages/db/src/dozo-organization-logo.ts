import type { DozoOrganizationLogo, DozoOrganizationMark } from "@rakazo/contracts";
import { GUEST_ROLE, isOwnerRole, LIVE_ORGANIZATION } from "./billing/billing.js";
import type { PrismaClient } from "./database/client.js";
import { Prisma } from "./database/client.js";
import { IsolationError } from "./database/scope.js";

type Db = Pick<PrismaClient, "member" | "spaceMember">;

/** A 128 px WebP the server drew is a few kilobytes; nothing larger is one of them. */
const STORED_LOGO_MAX_LENGTH = 100_000;

/**
 * Only a logo the server drew itself is shown. The column is the auth library's, so anything else
 * found there (an address, a value too large to be one) is never handed to an app to load.
 */
function storedLogo(value: string | null): string | null {
  return value?.startsWith("data:image/webp;base64,") && value.length <= STORED_LOGO_MAX_LENGTH
    ? value
    : null;
}

/**
 * The organization a Space belongs to, for a member of that Space: guests of a shared Space see
 * the host's logo there. Someone who has left the Space gets nothing.
 */
export async function readOrganizationMark(
  db: Db,
  input: { userId: string; spaceId: string },
): Promise<DozoOrganizationMark> {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      space: { select: { deletingAt: true, organization: { select: { name: true, logo: true } } } },
    },
  });
  if (!membership || membership.space.deletingAt) throw new IsolationError();
  const { name, logo } = membership.space.organization;
  return { name, logo: storedLogo(logo) };
}

/** One organization's logo, for its own members; a guest of one of its Spaces is not one. */
export async function readOrganizationLogo(
  db: Db,
  input: { userId: string; organizationId: string },
): Promise<DozoOrganizationLogo> {
  const member = await db.member.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      role: { not: GUEST_ROLE },
      organization: LIVE_ORGANIZATION,
    },
    select: { role: true, organization: { select: { logo: true } } },
  });
  if (!member) throw new IsolationError();
  return {
    logo: storedLogo(member.organization.logo),
    // Only the owner: no other organization role is ever given in this product.
    canManage: isOwnerRole(member.role),
  };
}

/**
 * Changes the logo for the organization's owner. The owner role is read with `isOwnerRole`, the
 * one rule for it, from the caller's member row held for the change, so a role taken away
 * meanwhile either waits for this write or stops it. Returns the organization's Spaces, whose
 * members' sidebars show it. The logo must already be one the server drew
 * (`encodeOrganizationLogo`), or null.
 */
export async function setOrganizationLogo(
  db: Pick<PrismaClient, "$transaction">,
  input: { userId: string; organizationId: string; logo: string | null },
): Promise<{ spaceIds: string[] }> {
  return db.$transaction(async (tx) => {
    const [member] = await tx.$queryRaw<Array<{ role: string }>>(Prisma.sql`
      SELECT "role" FROM "member"
      WHERE "organizationId" = ${input.organizationId} AND "userId" = ${input.userId}
      FOR SHARE`);
    if (!member || !isOwnerRole(member.role)) throw new IsolationError();
    const { count } = await tx.organization.updateMany({
      where: { id: input.organizationId, ...LIVE_ORGANIZATION },
      data: { logo: input.logo },
    });
    if (count === 0) throw new IsolationError();
    const spaces = await tx.space.findMany({
      where: { organizationId: input.organizationId, deletingAt: null },
      select: { id: true },
    });
    return { spaceIds: spaces.map((space) => space.id) };
  });
}
