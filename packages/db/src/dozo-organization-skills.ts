import { ClientError, skillNameKey } from "@rakazo/core";
import { availableInSpace } from "./availability.js";
import { isOwnerRole } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

type Scope = { spaceId: string; userId: string };
type Raw = Pick<PrismaClient, "$queryRaw">;

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

/** A library skill may not carry a built-in skill's name: it would stand in for it for everyone. */
export class SkillNamedLikeBuiltinError extends ClientError {
  constructor() {
    super("CONFLICT", "A built-in skill already has this name", "skill_builtin_name");
    this.name = "SkillNamedLikeBuiltinError";
  }
}

/**
 * The library skills of the organization the Space belongs to, as one member of that Space reads
 * them. Every condition holds on each read, never by clean-up: the reader is a member of the Space,
 * which is not being deleted; the person who shared the skill still owns the organization (the
 * owner role read as `isOwnerRole` does, by `dozo_is_owner_role`) and still owns the skill; the
 * skill is one they wrote. `hidden` chooses whether the skills the reader turned off for themselves
 * are left out (the default) or listed too. Row-level policies hold the same conditions.
 */
export function organizationLibrarySql(scope: Scope, hidden: "omit" | "include" = "omit") {
  const hide = Prisma.sql`EXISTS (
    SELECT 1 FROM "dozo_organization_skill_hides" h
    WHERE h."skillId" = l."skillId" AND h."userId" = ${scope.userId})`;
  return Prisma.sql`
    SELECT l."skillId", k."name", k."description", ${hide} AS "hidden"
    FROM "dozo_organization_skills" l
    JOIN "agent_skills" k ON k."id" = l."skillId"
      AND k."source" = 'user' AND k."userId" = l."sharedById"
    JOIN "spaces" s ON s."organizationId" = l."organizationId"
      AND s."id" = ${scope.spaceId} AND s."deletingAt" IS NULL
    JOIN "space_members" m ON m."spaceId" = s."id" AND m."userId" = ${scope.userId}
    JOIN "member" o ON o."organizationId" = l."organizationId"
      AND o."userId" = l."sharedById" AND dozo_is_owner_role(o."role")
    ${hidden === "omit" ? Prisma.sql`WHERE NOT ${hide}` : Prisma.empty}
    ORDER BY k."name", l."skillId"`;
}

type LibraryRow = { skillId: string; name: string; description: string; hidden: boolean };

/** The ids of the library skills a member reads in a Space, those they turned off left out. */
export async function organizationLibrarySkillIds(db: Raw, scope: Scope): Promise<string[]> {
  const rows = await db.$queryRaw<LibraryRow[]>(organizationLibrarySql(scope));
  return rows.map((row) => row.skillId);
}

/**
 * The skills a person reads in a Space: their own, where `availableInSpace` puts them, and the
 * organization library's. For reading only: changing a skill keeps `availableInSpace`, which names
 * its owner, so only the owner ever changes a library skill.
 */
export async function skillsReadableInSpace(db: Raw, scope: Scope) {
  const library = await organizationLibrarySkillIds(db, scope);
  return {
    OR: [availableInSpace(scope), { source: "user", id: { in: library } }],
  } satisfies Prisma.AgentSkillWhereInput;
}

/**
 * The skills as one person sees them: a library skill named like one of their own gives way to
 * theirs, the one closer to them, and one named like a built-in skill gives way to the built-in,
 * so someone else's skill never stands in for either. Names compare by `skillNameKey`, the key the
 * resolver finds a skill by.
 */
export function preferOwnSkills<T extends { userId: string; name: string }>(
  rows: readonly T[],
  userId: string,
  builtinNames: readonly string[],
): T[] {
  const taken = new Set([
    ...builtinNames.map(skillNameKey),
    ...rows.filter((row) => row.userId === userId).map((row) => skillNameKey(row.name)),
  ]);
  return rows.filter((row) => row.userId === userId || !taken.has(skillNameKey(row.name)));
}

/** The organization of the Space when this person owns it; one rule for the owner role. */
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

export type OrganizationLibrary = {
  skillIds: string[];
  canShare: boolean;
  /** The library skills this member turned off for themselves, to turn back on. */
  hidden: Array<{ id: string; name: string; description: string }>;
};

/**
 * The library of the organization the Space belongs to, for one of its members: which skills are
 * in it, which they turned off, and whether they may put theirs in. Only its owner may, and only
 * once the organization has someone to share with.
 */
export async function readOrganizationLibrary(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: Scope,
): Promise<OrganizationLibrary> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LibraryRow[]>(organizationLibrarySql(scope, "include"));
    const organizationId = await ownsSpaceOrganization(tx, scope, false);
    let canShare = false;
    if (organizationId) {
      const [{ others }] = await tx.$queryRaw<[{ others: number }]>(Prisma.sql`
        SELECT count(*)::int AS "others" FROM "member"
        WHERE "organizationId" = ${organizationId} AND "userId" <> ${scope.userId}`);
      canShare = others > 0;
    }
    return {
      skillIds: rows.map((row) => row.skillId),
      canShare,
      hidden: rows
        .filter((row) => row.hidden)
        .map((row) => ({ id: row.skillId, name: row.name, description: row.description })),
    };
  });
}

/**
 * Puts one of the owner's own skills in their organization's library, or takes it out. The owner
 * role is read from their member row, held for the change; the skill must be theirs, written by
 * them (not a plugin's), available where they are, and not named like a built-in skill. A skill is
 * in one library at most. Returns the organization's Spaces, whose members' apps read their skills
 * again.
 */
export async function shareSkillWithOrganization(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: Scope,
  input: { skillId: string; shared: boolean; builtinNames: readonly string[] },
): Promise<{ spaceIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    const organizationId = await ownsSpaceOrganization(tx, scope, true);
    if (!organizationId) throw new IsolationError();
    const skill = await tx.agentSkill.findFirst({
      where: { id: input.skillId, source: "user", ...availableInSpace(scope) },
      select: { id: true, name: true },
    });
    if (!skill) throw new IsolationError();
    if (input.shared) {
      const name = skillNameKey(skill.name);
      if (input.builtinNames.some((builtin) => skillNameKey(builtin) === name))
        throw new SkillNamedLikeBuiltinError();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "dozo_organization_skills" ("skillId", "organizationId", "sharedById")
        VALUES (${skill.id}, ${organizationId}, ${scope.userId})
        ON CONFLICT ("skillId") DO NOTHING`);
      // The row as it stands, a concurrent share's included: in this library is done; in
      // another, it stays there.
      const [held] = await tx.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
        SELECT "organizationId" FROM "dozo_organization_skills" WHERE "skillId" = ${skill.id}`);
      if (held?.organizationId !== organizationId) throw new SkillInAnotherLibraryError();
    } else {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "dozo_organization_skills"
        WHERE "skillId" = ${skill.id} AND "organizationId" = ${organizationId}`);
    }
    return { spaceIds: await organizationSpaceIds(tx, organizationId) };
  });
}

async function organizationSpaceIds(tx: Pick<PrismaClient, "space">, organizationId: string) {
  const spaces = await tx.space.findMany({
    where: { organizationId, deletingAt: null },
    select: { id: true },
  });
  return spaces.map((space) => space.id);
}

/**
 * Turns a library skill off or on again for one member: off, their bots no longer use it. Only a
 * library skill they read in this Space can be turned off.
 */
export async function hideLibrarySkill(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: Scope,
  input: { skillId: string; hidden: boolean },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LibraryRow[]>(organizationLibrarySql(scope, "include"));
    if (!rows.some((row) => row.skillId === input.skillId)) throw new IsolationError();
    await tx.$executeRaw(
      input.hidden
        ? Prisma.sql`
            INSERT INTO "dozo_organization_skill_hides" ("skillId", "userId")
            VALUES (${input.skillId}, ${scope.userId}) ON CONFLICT DO NOTHING`
        : Prisma.sql`
            DELETE FROM "dozo_organization_skill_hides"
            WHERE "skillId" = ${input.skillId} AND "userId" = ${scope.userId}`,
    );
  });
}

/**
 * The Spaces whose members read this skill from a library, to signal after its owner changes or
 * deletes it; none when it is in no library. Read before the change, as a deletion takes the
 * library row with it.
 */
export async function libraryReaderSpaces(
  db: Pick<PrismaClient, "$queryRaw" | "space">,
  skillId: string,
): Promise<string[]> {
  const [row] = await db.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
    SELECT "organizationId" FROM "dozo_organization_skills" WHERE "skillId" = ${skillId}`);
  return row ? organizationSpaceIds(db, row.organizationId) : [];
}
