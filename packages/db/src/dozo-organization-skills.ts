import { ClientError } from "@rakazo/core";
import { availableInSpace } from "./availability.js";
import { isOwnerRole } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

type Scope = { spaceId: string; userId: string };

/** The skill is in the library of another organization its owner owns; it stays there. */
export class SkillInAnotherLibraryError extends ClientError {
  constructor() {
    super(
      "CONFLICT",
      "This skill is already shared with another organization",
      "skill_in_other_library",
    );
    this.name = "SkillInAnotherLibraryError";
  }
}

/**
 * A skill in the library of the organization the Space belongs to, for a member of that Space.
 * Membership is part of the condition, so someone who leaves the Space stops reading the library
 * at once. Only a skill its owner wrote counts: a plugin's skill comes with the owner's install.
 */
export function inOrganizationLibrary(scope: Scope) {
  return {
    source: "user",
    dozoLibrary: {
      is: {
        organization: {
          spaces: {
            some: {
              id: scope.spaceId,
              deletingAt: null,
              memberships: { some: { userId: scope.userId } },
            },
          },
        },
      },
    },
  } satisfies Prisma.AgentSkillWhereInput;
}

/**
 * The skills a person reads in a Space: their own, where `availableInSpace` puts them, and the
 * organization library's. For reading only: changing a skill keeps `availableInSpace`, which names
 * its owner, so only the owner ever changes a library skill.
 */
export function skillsReadableInSpace(scope: Scope) {
  return {
    OR: [availableInSpace(scope), inOrganizationLibrary(scope)],
  } satisfies Prisma.AgentSkillWhereInput;
}

/**
 * The skills as one person sees them: a library skill named like one of their own gives way to
 * theirs, the one closer to them, so a name always means one skill.
 */
export function preferOwnSkills<T extends { userId: string; name: string }>(
  rows: readonly T[],
  userId: string,
): T[] {
  const own = new Set(
    rows.filter((row) => row.userId === userId).map((row) => row.name.toLowerCase()),
  );
  return rows.filter((row) => row.userId === userId || !own.has(row.name.toLowerCase()));
}

/** Whether the person is the owner of the organization the Space belongs to; one rule for it. */
async function ownsSpaceOrganization(
  tx: Prisma.TransactionClient,
  scope: Scope,
  lock: boolean,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ organizationId: string; role: string }>>(Prisma.sql`
    SELECT m."organizationId", m."role" FROM "member" m
    JOIN "spaces" s ON s."organizationId" = m."organizationId"
    WHERE s."id" = ${scope.spaceId} AND s."deletingAt" IS NULL AND m."userId" = ${scope.userId}
    ${lock ? Prisma.sql`FOR SHARE OF m` : Prisma.empty}`);
  const member = rows[0];
  return member && isOwnerRole(member.role) ? member.organizationId : null;
}

/**
 * The library of the organization the Space belongs to, for one of its members: which skills are
 * in it, and whether this person may put theirs in. Only its owner may, and only once the
 * organization has someone to share with.
 */
export async function readOrganizationLibrary(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: Scope,
): Promise<{ skillIds: string[]; canShare: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ skillId: string }>>(Prisma.sql`
      SELECT l."skillId" FROM "dozo_organization_skills" l
      JOIN "spaces" s ON s."organizationId" = l."organizationId"
      JOIN "space_members" m ON m."spaceId" = s."id"
      WHERE s."id" = ${scope.spaceId} AND s."deletingAt" IS NULL AND m."userId" = ${scope.userId}
      ORDER BY l."sharedAt", l."skillId"`);
    const organizationId = await ownsSpaceOrganization(tx, scope, false);
    let canShare = false;
    if (organizationId) {
      const [{ others }] = await tx.$queryRaw<[{ others: number }]>(Prisma.sql`
        SELECT count(*)::int AS "others" FROM "member"
        WHERE "organizationId" = ${organizationId} AND "userId" <> ${scope.userId}`);
      canShare = others > 0;
    }
    return { skillIds: rows.map((row) => row.skillId), canShare };
  });
}

/**
 * Puts one of the owner's own skills in their organization's library, or takes it out. The owner
 * role is read from their member row, held for the change; the skill must be theirs, written by
 * them (not a plugin's) and available where they are. Returns the organization's Spaces, whose
 * members' apps read their skills again.
 */
export async function shareSkillWithOrganization(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: Scope,
  input: { skillId: string; shared: boolean },
): Promise<{ spaceIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    const organizationId = await ownsSpaceOrganization(tx, scope, true);
    if (!organizationId) throw new IsolationError();
    const skill = await tx.agentSkill.findFirst({
      where: { id: input.skillId, source: "user", ...availableInSpace(scope) },
      select: { id: true },
    });
    if (!skill) throw new IsolationError();
    // A skill is in one library: one in another organization's stays there, unchanged.
    const [held] = await tx.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT "organizationId" FROM "dozo_organization_skills"
      WHERE "skillId" = ${skill.id}
      FOR UPDATE`);
    if (input.shared) {
      if (held && held.organizationId !== organizationId) throw new SkillInAnotherLibraryError();
      if (!held)
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "dozo_organization_skills" ("skillId", "organizationId", "sharedById")
          VALUES (${skill.id}, ${organizationId}, ${scope.userId})
          ON CONFLICT ("skillId") DO NOTHING`);
    } else {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "dozo_organization_skills"
        WHERE "skillId" = ${skill.id} AND "organizationId" = ${organizationId}`);
    }
    const spaces = await tx.space.findMany({
      where: { organizationId, deletingAt: null },
      select: { id: true },
    });
    return { spaceIds: spaces.map((space) => space.id) };
  });
}
