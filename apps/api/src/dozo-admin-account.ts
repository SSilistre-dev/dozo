import { sandboxKindsWhere } from "@rakazo/adapters";
import { banKeys, bannedEntries } from "@rakazo/auth";
import type { DozoAdminAccount } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { sharedSpaceUsage } from "@rakazo/db";
import {
  DOZO_ADMIN_ORGANIZATION_SELECT,
  ownedOrganizations,
  planOfOrganization,
} from "./dozo-admin-members.js";

/** How many of an account's sign-ins its page shows, most recently used first. */
export const DOZO_ADMIN_ACCOUNT_SESSIONS = 5;

/**
 * One account as its admin page shows it: who it is, its plan and every date that ends one, where
 * it works, what its files take and its latest sign-ins. Nothing it holds (messages, files,
 * memory) is read. Run as system work by the caller; `where` keeps out what the list keeps out.
 */
export async function readAccount(
  prisma: PrismaClient,
  where: object,
  userId: string,
  now: Date,
): Promise<Omit<DozoAdminAccount, "admin">> {
  const user = await prisma.user.findFirst({
    where: { ...where, id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      createdAt: true,
      deactivatedAt: true,
    },
  });
  if (!user) throw new ClientError("NOT_FOUND", "Account not found");
  const ownMachine = new Set(sandboxKindsWhere((capabilities) => capabilities.runsOnUserMachine));
  const [owned, banned, memberships, bots, computers, sessions] = await Promise.all([
    ownedOrganizations(prisma, [userId]),
    bannedEntries(prisma, [user.email]),
    prisma.spaceMember.findMany({
      where: { userId, space: { deletingAt: null } },
      orderBy: { createdAt: "asc" },
      select: { space: { select: { id: true, name: true, organizationId: true } } },
    }),
    prisma.bot.findMany({
      where: { userId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    prisma.computer.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        state: true,
        kind: true,
        runningSince: true,
        bots: {
          where: { archivedAt: null },
          orderBy: { createdAt: "asc" },
          select: { name: true },
        },
      },
    }),
    prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: DOZO_ADMIN_ACCOUNT_SESSIONS,
      select: { id: true, createdAt: true, updatedAt: true, userAgent: true },
    }),
  ]);
  const organizationId = owned.get(userId);
  const organization = organizationId
    ? await prisma.organization.findUnique({
        where: { id: organizationId },
        select: DOZO_ADMIN_ORGANIZATION_SELECT,
      })
    : null;
  const storage = organization
    ? await sharedSpaceUsage(
        prisma,
        organization.id,
        organization.billing,
        organization.dozoPlanGrant,
      )
    : null;
  const billing = organization?.billing;
  const freeUntil = organization?.modelCredits?.byokFreeUntil;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
    suspended: Boolean(user.deactivatedAt),
    banned: banKeys(user.email).some((key) => banned.has(key)),
    plan: planOfOrganization(organization, now),
    billing: billing
      ? {
          status: billing.status,
          trialEndsAt: billing.trialEndsAt?.toISOString() ?? null,
          currentPeriodEndsAt: billing.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
        }
      : null,
    freeUntil: freeUntil && freeUntil > now ? freeUntil.toISOString() : null,
    storage: storage && { usedBytes: storage.usedBytes, limitBytes: storage.limitBytes },
    spaces: memberships.map(({ space }) => ({
      id: space.id,
      name: space.name,
      owned: space.organizationId === organizationId,
    })),
    bots,
    computers: computers.map((computer) => ({
      id: computer.id,
      running: computer.state === "running",
      ownMachine: ownMachine.has(computer.kind),
      runningSince: computer.runningSince?.toISOString() ?? null,
      bots: computer.bots.map((bot) => bot.name),
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.updatedAt.toISOString(),
      userAgent: session.userAgent,
    })),
  };
}
