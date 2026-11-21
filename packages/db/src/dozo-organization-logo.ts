import type { DozoOrganizationLogo, DozoOrganizationMark } from "@rakazo/contracts";
import { GUEST_ROLE, LIVE_ORGANIZATION } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type Db = Pick<PrismaClient, "member" | "organization" | "space" | "spaceMember">;

/** The roles that may change how the organization looks; Better Auth stores a comma list. */
const MANAGER_ROLES = ["owner", "admin"];
const MANAGER = { OR: MANAGER_ROLES.map((role) => ({ role: { contains: role } })) };

export function managesOrganizationLook(role: string): boolean {
  return role.split(",").some((value) => MANAGER_ROLES.includes(value.trim()));
}

/**
 * Only a logo the server drew itself is shown. The column is the auth library's, so anything else
 * found there (an address, say) is never handed to an app to load.
 */
function storedLogo(value: string | null): string | null {
  return value?.startsWith("data:image/webp;base64,") ? value : null;
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
    canManage: managesOrganizationLook(member.role),
  };
}

/**
 * Changes the logo for an owner or admin, in one statement that checks the role, so a role taken
 * away meanwhile changes nothing. Returns the organization's Spaces, whose members' sidebars show
 * it. The logo must already be one the server drew (`encodeOrganizationLogo`), or null.
 */
export async function setOrganizationLogo(
  db: Db,
  input: { userId: string; organizationId: string; logo: string | null },
): Promise<{ spaceIds: string[] }> {
  const { count } = await db.organization.updateMany({
    where: {
      id: input.organizationId,
      members: { some: { userId: input.userId, ...MANAGER } },
      ...LIVE_ORGANIZATION,
    },
    data: { logo: input.logo },
  });
  if (count === 0) throw new IsolationError();
  const spaces = await db.space.findMany({
    where: { organizationId: input.organizationId, deletingAt: null },
    select: { id: true },
  });
  return { spaceIds: spaces.map((space) => space.id) };
}
