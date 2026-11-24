import { sandboxKindsWhere } from "@rakazo/adapters";
import { banKeys, bannedEntries } from "@rakazo/auth";
import type { DozoAdminAccount } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, ownedOrganizationId } from "@rakazo/db";

/** How many of an account's sign-ins its page shows, most recently used first. */
const DOZO_ADMIN_ACCOUNT_SESSIONS = 5;
/** How many of an account's Spaces, bots and computers its page lists, oldest first. */
const DOZO_ADMIN_ACCOUNT_LIST = 50;

/**
 * One account as its admin page shows it: who it is, where it works and its latest sign-ins.
 * Nothing it holds (messages, files, memory) is read. Run as system work by the caller; `where`
 * keeps out what the list keeps out.
 */
export async function readAccount(
  prisma: PrismaClient,
  where: object,
  userId: string,
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
  const [organizationId, banned, memberships, bots, computers, sessions] = await Promise.all([
    ownedOrganizationId(prisma, userId).catch((error) => {
      if (error instanceof IsolationError) return undefined;
      throw error;
    }),
    bannedEntries(prisma, [user.email]),
    prisma.spaceMember.findMany({
      where: { userId, space: { deletingAt: null } },
      orderBy: { createdAt: "asc" },
      take: DOZO_ADMIN_ACCOUNT_LIST,
      select: { space: { select: { id: true, name: true, organizationId: true } } },
    }),
    prisma.bot.findMany({
      where: { userId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      take: DOZO_ADMIN_ACCOUNT_LIST,
      select: { id: true, name: true },
    }),
    prisma.computer.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: DOZO_ADMIN_ACCOUNT_LIST,
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
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
    suspended: Boolean(user.deactivatedAt),
    banned: banKeys(user.email).some((key) => banned.has(key)),
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
