import { createRouterClient } from "@orpc/server";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { DozoPaymentLedger } from "@rakazo/adapters";
import { sandboxKindCapabilities, sandboxKindsWhere } from "@rakazo/adapters";
import type { AccountDeletionAuth } from "@rakazo/auth";
import {
  addBan,
  banEntry,
  banKeys,
  bannedEntries,
  deleteAccountAsOperator,
  listBans,
  removeBan,
} from "@rakazo/auth";
import type { DozoAdminUsersSort } from "@rakazo/contracts";
import { ClientError, MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import {
  IsolationError,
  ownedOrganizationId,
  readSiteSettings,
  recordAuditEvent,
  recordSecurityEvent,
  revokePlanGrant,
  runAsSystem,
  setPlanGrant,
  signupsOpenFrom,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { setAccountActive } from "./account-status.js";
import { isAdmin, requireAdmin } from "./admins.js";
import { dozoAdminAccessRoutes } from "./dozo-admin-access.js";
import { readAccount } from "./dozo-admin-account.js";
import { dozoAdminBillingRoutes } from "./dozo-admin-billing.js";
import { dozoAdminFunnelRoutes } from "./dozo-admin-funnel.js";
import { onTier, plansOf } from "./dozo-admin-members.js";
import { dozoAdminPlansRoutes } from "./dozo-admin-plans.js";
import { dozoEventsRoutes } from "./dozo-events.js";
import { dozoUsageRoutes } from "./dozo-usage.js";
import type { RouterDeps } from "./router.js";
import { computerRoutes } from "./routes/computer.js";
import type { RouterContext } from "./routes/context.js";
import { spendingLimitRoutes as upstreamSpendingLimitRoutes } from "./routes/spending-limit.js";
import { afterSpaceDeparture } from "./space-departure.js";
import type { DeviceStore } from "./user-devices.js";
import { revokeUserDevices } from "./user-devices.js";

export const DOZO_ADMIN_USERS_PAGE = 50;
const DOZO_ADMIN_COMPUTERS_LIMIT = 100;
/** The list's orders; the id breaks ties so the cursor is stable. */
const USERS_ORDER = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  email: [{ email: "asc" }, { id: "asc" }],
} as const satisfies Record<DozoAdminUsersSort, object[]>;
/** How far ahead an admin can end a granted plan. */
const DOZO_ADMIN_PLAN_MAX_YEARS = 5;

/** The end of a granted plan: required, in the future and within `DOZO_ADMIN_PLAN_MAX_YEARS`. */
function grantEnd(value: string | undefined, now: Date): Date {
  if (!value) throw new ClientError("BAD_REQUEST", "An end date is required");
  const endsAt = new Date(value);
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + DOZO_ADMIN_PLAN_MAX_YEARS);
  if (endsAt <= now) throw new ClientError("BAD_REQUEST", "The end date must be in the future");
  if (endsAt > latest)
    throw new ClientError(
      "BAD_REQUEST",
      `The end date must be within ${DOZO_ADMIN_PLAN_MAX_YEARS} years`,
    );
  return endsAt;
}

/** What the admin routes need from the server that the router's own dependencies do not carry. */
export interface DozoAdminWiring {
  devices: DeviceStore;
  /** While a directory provisions accounts, it owns turning them off and on. */
  directoryProvisioning: boolean;
  /** SIGNUPS_ENABLED as the environment has it; the admin's site setting wins over it. */
  signupsEnabled: string | undefined;
  /** The server's auth, whose account deletion the admin page runs for someone else. */
  auth: AccountDeletionAuth;
  /** The fanout that tells open apps a site setting changed; absent, nobody is told. */
  realtime?: RealtimeFanout;
  /** What the billing page reads payments from; absent when no payment provider is configured. */
  payments?: DozoPaymentLedger;
}

/** Spread into the router's dependencies where the server builds them. */
export function dozoAdminWiring(wiring: DozoAdminWiring): { dozoAdmin: DozoAdminWiring } {
  return { dozoAdmin: wiring };
}

/**
 * The hosted deployment's admin page. Every procedure is refused unless the caller's verified
 * email is in RAKAZO_ADMIN_EMAILS, before anything is read. The reads cross tenants, so they run
 * as named system work and return only what the page lists: nothing an account holds.
 */
export function dozoAdminRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const wiring = (deps as RouterDeps & { dozoAdmin?: DozoAdminWiring }).dozoAdmin;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    return next();
  });
  // Chat-app contacts are internal rows with no sign-in; the page lists people.
  const accounts = { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } };
  // A computer on a person's own machine is theirs to stop, and costs the deployment nothing.
  const hosted = {
    state: "running",
    kind: { notIn: sandboxKindsWhere((capabilities) => capabilities.runsOnUserMachine) },
  };
  const requireWiring = () => {
    if (!wiring) throw new Error("The admin routes were built without their wiring");
    return wiring;
  };
  /** Upstream's account deactivation, for an account the page lists. */
  const suspend = async (userId: string, suspended: boolean) => {
    const { devices, directoryProvisioning } = requireWiring();
    const outcome = await setAccountActive(
      {
        prisma,
        pushTokens: deps.pushTokens,
        devices,
        events: deps.events,
        afterDeparture: (actor, departure) => afterSpaceDeparture(deps, actor, departure),
      },
      userId,
      !suspended,
      directoryProvisioning,
    );
    if (outcome === "directory")
      throw new ClientError("CONFLICT", "The identity provider manages this account");
  };
  /** The list is a setting of the deployment; the event's user is the admin who changed it. */
  const recordBanChange = (adminId: string, change: "added" | "removed", entry: string) =>
    recordSecurityEvent({
      type: "deployment.settings.changed",
      userId: adminId,
      metadata: { setting: "ban_list", change, entry },
    });
  const findAccount = async (userId: string) => {
    const user = await runAsSystem("find an account for the admin page", () =>
      prisma.user.findFirst({ where: { ...accounts, id: userId }, select: { email: true } }),
    );
    if (!user) throw new ClientError("NOT_FOUND", "Account not found");
    return user;
  };

  return {
    dozoAdmin: {
      users: admin.dozoAdmin.users.handler(({ input }) =>
        runAsSystem("list accounts for the admin page", async () => {
          const now = new Date();
          const query = input.query?.trim();
          const where = {
            ...accounts,
            ...(query ? { email: { contains: query, mode: "insensitive" as const } } : {}),
            ...(input.status
              ? { deactivatedAt: input.status === "suspended" ? { not: null } : null }
              : {}),
            // Its own conditions, so none of them replaces one of the account filter's.
            ...(input.plan ? { AND: [onTier(input.plan, now)] } : {}),
          };
          const filtered = Boolean(query || input.status || input.plan);
          const [rows, matching] = await Promise.all([
            prisma.user.findMany({
              where,
              orderBy: USERS_ORDER[input.sort ?? "newest"],
              take: DOZO_ADMIN_USERS_PAGE + 1,
              // The cursor is the first row of the page it asks for.
              ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
              select: { id: true, email: true, name: true, createdAt: true, deactivatedAt: true },
            }),
            // Unfiltered, what matches is every account, which is counted below anyway.
            filtered ? prisma.user.count({ where }) : null,
          ]);
          const page = rows.slice(0, DOZO_ADMIN_USERS_PAGE);
          const mine = { userId: { in: page.map((user) => user.id) } };
          const [site, banned, total, sessions, bots, computers, planOf] = await Promise.all([
            readSiteSettings(prisma),
            bannedEntries(
              prisma,
              page.map((user) => user.email),
            ),
            prisma.user.count({ where: accounts }),
            prisma.session.groupBy({ by: ["userId"], where: mine, _max: { updatedAt: true } }),
            prisma.bot.groupBy({
              by: ["userId"],
              where: { ...mine, archivedAt: null },
              _count: { _all: true },
            }),
            prisma.computer.groupBy({
              by: ["userId"],
              where: { ...mine, ...hosted },
              _count: { _all: true },
            }),
            plansOf(
              prisma,
              page.map((user) => user.id),
              now,
            ),
          ]);
          const lastSeen = new Map(sessions.map((row) => [row.userId, row._max.updatedAt]));
          const botCount = new Map(bots.map((row) => [row.userId, row._count._all]));
          const computerCount = new Map(computers.map((row) => [row.userId, row._count._all]));
          return {
            signupsOpen: signupsOpenFrom(site, wiring?.signupsEnabled),
            total,
            matching: matching ?? total,
            users: page.map((user) => ({
              id: user.id,
              email: user.email,
              name: user.name,
              createdAt: user.createdAt.toISOString(),
              lastSeenAt: lastSeen.get(user.id)?.toISOString() ?? null,
              bots: botCount.get(user.id) ?? 0,
              runningComputers: computerCount.get(user.id) ?? 0,
              suspended: Boolean(user.deactivatedAt),
              plan: planOf(user.id),
              banned: banKeys(user.email).some((key) => banned.has(key)),
            })),
            nextCursor: rows[DOZO_ADMIN_USERS_PAGE]?.id ?? null,
          };
        }),
      ),

      user: admin.dozoAdmin.user.handler(async ({ input }) => {
        const account = await runAsSystem("read an account for the admin page", () =>
          readAccount(prisma, accounts, input.userId, new Date()),
        );
        return { ...account, admin: await isAdmin(deps, input.userId) };
      }),

      /** Only the display name: the address is how the account signs in, so it stays. */
      rename: admin.dozoAdmin.rename.handler(async ({ context, input }) => {
        await findAccount(input.userId);
        await runAsSystem("rename an account from the admin page", () =>
          prisma.user.update({ where: { id: input.userId }, data: { name: input.name } }),
        );
        // In the account's own audit log, as a granted plan is: the admin only as an opaque id.
        await recordAuditEvent({
          action: "user.renamed",
          actor: { type: "system", label: "Operator" },
          userId: input.userId,
          target: { type: "user", id: input.userId },
          metadata: { adminId: context.actor.userId },
        });
        getLogger().info("dozo.admin.account_rename", {
          "admin.id": context.actor.userId,
          "user.id": input.userId,
        });
        return { name: input.name };
      }),

      /**
       * Signs the account out everywhere, as deactivating it does, but leaves it able to sign in
       * again: its sessions, paired computers, notification sign-ups, pending chat-app link codes
       * and links to its bots' screens end. Every step is tried even when one fails, the event is
       * recorded either way, and the failures are reported together; running it again is safe.
       * An admin may sign out of their own sessions, never another admin's.
       */
      endSessions: admin.dozoAdmin.endSessions.handler(async ({ context, input }) => {
        const { devices } = requireWiring();
        if (input.userId !== context.actor.userId && (await isAdmin(deps, input.userId)))
          throw new ClientError("BAD_REQUEST", "Another admin's sessions cannot be ended");
        await findAccount(input.userId);
        const { userId } = input;
        const steps: Array<() => Promise<unknown>> = [
          () => prisma.session.deleteMany({ where: { userId } }),
          () => revokeUserDevices(devices, userId),
          () => deps.pushTokens.remove(userId),
          () => prisma.callPushDevice.deleteMany({ where: { userId } }),
          () => prisma.messagingLinkCode.deleteMany({ where: { userId } }),
          () =>
            prisma.bot.updateMany({
              where: { userId },
              data: { screenGeneration: { increment: 1 } },
            }),
        ];
        const failures: unknown[] = [];
        await runAsSystem("end an account's sessions from the admin page", async () => {
          for (const step of steps)
            await (async () => step())().catch((error: unknown) => failures.push(error));
        });
        await recordSecurityEvent({
          type: "auth.session.revoked",
          userId,
          metadata: { by: "operator", admin: context.actor.userId, complete: !failures.length },
        });
        getLogger().info("dozo.admin.sessions_end", {
          "admin.id": context.actor.userId,
          "user.id": userId,
          failures: failures.length,
        });
        if (failures.length)
          throw new AggregateError(failures, "Could not end every sign-in of the account");
        return { ok: true as const };
      }),

      /**
       * Suspending is upstream's account deactivation: sign-in is refused, open sessions and
       * paired devices end, running work is cancelled and no new run starts. The account also
       * leaves other people's Spaces, which reactivating does not undo.
       */
      setSuspended: admin.dozoAdmin.setSuspended.handler(async ({ context, input }) => {
        // The caller is one, so this also keeps an admin from suspending their own account.
        if (input.suspended && (await isAdmin(deps, input.userId)))
          throw new ClientError("BAD_REQUEST", "An admin account cannot be suspended");
        requireWiring();
        await findAccount(input.userId);
        await suspend(input.userId, input.suspended);
        getLogger().info("dozo.admin.account_status", {
          "admin.id": context.actor.userId,
          "user.id": input.userId,
          suspended: input.suspended,
        });
        return { suspended: input.suspended };
      }),

      /**
       * Gives the account's own organization a plan by hand, or ends the one it was given. The
       * subscription sync never touches it and a grant ends by its own date. Both are audited.
       */
      setPlan: admin.dozoAdmin.setPlan.handler(async ({ context, input }) => {
        const now = new Date();
        const grant = input.tier ? { tier: input.tier, endsAt: grantEnd(input.endsAt, now) } : null;
        const target = await runAsSystem(
          "find an account's organization for the admin page",
          async () => {
            const user = await prisma.user.findFirst({
              where: { ...accounts, id: input.userId },
              select: { id: true, email: true },
            });
            if (!user) throw new ClientError("NOT_FOUND", "Account not found");
            const organizationId = await ownedOrganizationId(prisma, user.id).catch((error) => {
              if (error instanceof IsolationError)
                throw new ClientError("NOT_FOUND", "Account has no organization of its own");
              throw error;
            });
            return { user, organizationId };
          },
        );
        const { organizationId } = target;
        // Setting a plan always changes it; ending one changes it only when there was one.
        const changed = await runAsSystem("change a granted plan for the admin page", async () => {
          if (!grant) return revokePlanGrant(prisma, organizationId);
          await setPlanGrant(prisma, {
            organizationId,
            ...grant,
            grantedById: context.actor.userId,
            note: input.note,
          });
          return true;
        });
        // The organization reads its own audit log, so the event carries neither the admin's
        // email nor the internal note (which stays on the grant row), only the admin's opaque id:
        // a new grant overwrites the row's `grantedById` and ending one deletes the row, so this
        // is the lasting record of who did it. It is a second write because the audit primitive
        // opens its own transaction and takes none.
        if (changed)
          await recordAuditEvent({
            action: grant ? "plan.granted" : "plan.grant_ended",
            actor: { type: "system", label: "Operator" },
            organizationId,
            target: { type: "user", id: target.user.id },
            metadata: {
              adminId: context.actor.userId,
              tier: grant?.tier ?? null,
              endsAt: grant?.endsAt.toISOString() ?? null,
            },
          });
        getLogger().info("dozo.admin.plan", {
          "admin.id": context.actor.userId,
          "user.id": input.userId,
          "plan.tier": grant?.tier ?? null,
          "plan.ends_at": grant?.endsAt.toISOString() ?? null,
        });
        const planOf = await runAsSystem("read a plan for the admin page", () =>
          plansOf(prisma, [input.userId], new Date()),
        );
        return { plan: planOf(input.userId) };
      }),

      bans: admin.dozoAdmin.bans.handler(async () => ({
        bans: (await listBans(prisma)).map((ban) => ({
          value: ban.value,
          createdAt: ban.createdAt.toISOString(),
        })),
      })),

      /**
       * A listed address or domain is refused at sign-up and sign-in, and its open sessions stop
       * being admitted. Banning an account suspends it first, so a suspension the directory
       * refuses lists nothing. No entry may cover an admin's address: it would lock the admin out.
       */
      ban: admin.dozoAdmin.ban.handler(async ({ context, input }) => {
        const userId = "userId" in input ? input.userId : undefined;
        if (userId) requireWiring();
        const value = banEntry(
          "userId" in input ? (await findAccount(input.userId)).email : input.value,
        );
        if (!value) throw new ClientError("BAD_REQUEST", "Enter an email address or a domain");
        if ((deps.env.adminEmails ?? []).some((email) => banKeys(email).includes(value)))
          throw new ClientError("BAD_REQUEST", "An admin account cannot be banned");
        if (userId) await suspend(userId, true);
        await addBan(prisma, value, context.actor.userId);
        await recordBanChange(context.actor.userId, "added", value);
        getLogger().info("dozo.admin.ban", {
          "admin.id": context.actor.userId,
          "user.id": userId,
          ban: value,
          banned: true,
        });
        return { value };
      }),

      /** Lifts the entry only: an account suspended with it stays suspended until restored. */
      unban: admin.dozoAdmin.unban.handler(async ({ context, input }) => {
        // As stored; an entry from before a change of form is still found as typed.
        const value = banEntry(input.value) ?? input.value;
        await removeBan(prisma, value);
        await recordBanChange(context.actor.userId, "removed", value);
        getLogger().info("dozo.admin.ban", {
          "admin.id": context.actor.userId,
          ban: value,
          banned: false,
        });
        return { ok: true as const };
      }),

      /**
       * Suspends the account, so it does nothing more while its content goes, then deletes it the
       * way its own "delete my account" does. A failure part way leaves it suspended, and deleting
       * again resumes. The deletion records its own security event once the account is gone.
       */
      deleteUser: admin.dozoAdmin.deleteUser.handler(async ({ context, input }) => {
        // The caller is one, so this also keeps an admin from deleting their own account.
        if (await isAdmin(deps, input.userId))
          throw new ClientError("BAD_REQUEST", "An admin account cannot be deleted");
        const { auth } = requireWiring();
        await findAccount(input.userId);
        await suspend(input.userId, true);
        // Before anything goes: the deletion's own event names nobody, and comes last.
        await recordSecurityEvent({
          type: "auth.account.deactivated",
          userId: input.userId,
          metadata: { by: "operator", admin: context.actor.userId, reason: "deletion" },
        });
        const deleted = await runAsSystem("delete an account from the admin page", () =>
          deleteAccountAsOperator(auth, input.userId),
        );
        if (!deleted) throw new ClientError("NOT_FOUND", "Account not found");
        getLogger().info("dozo.admin.account_delete", {
          "admin.id": context.actor.userId,
          "user.id": input.userId,
        });
        return { ok: true as const };
      }),

      computers: admin.dozoAdmin.computers.handler(() =>
        runAsSystem("list running computers for the admin page", async () => {
          const [total, rows] = await Promise.all([
            prisma.computer.count({ where: hosted }),
            prisma.computer.findMany({
              where: hosted,
              orderBy: [{ runningSince: "asc" }, { id: "asc" }],
              take: DOZO_ADMIN_COMPUTERS_LIMIT,
              select: {
                id: true,
                userId: true,
                runningSince: true,
                bots: {
                  where: { archivedAt: null },
                  orderBy: { createdAt: "asc" },
                  select: { name: true },
                },
              },
            }),
          ]);
          const owners = await prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
            select: { id: true, email: true },
          });
          const emails = new Map(owners.map((owner) => [owner.id, owner.email]));
          // The page works without the figure, so a failed read only leaves it out.
          const memory = await bestEffort(
            "read the computers' memory for the admin page",
            sandboxKindCapabilities(deps.sandbox?.describe().id).memory?.(),
          );
          return {
            total,
            ...(memory ? { memory } : {}),
            computers: rows.map((row) => ({
              id: row.id,
              email: emails.get(row.userId) ?? null,
              bots: row.bots.map((bot) => bot.name),
              runningSince: row.runningSince?.toISOString() ?? null,
            })),
          };
        }),
      ),

      /**
       * Runs the app's own Stop for one of the computer's bots, as the person who holds the
       * computer (whoever controls its screen, otherwise the bot's owner), so saving, leases and
       * metering end as they do for that person. Its refusals (busy, other bots still working)
       * reach the admin unchanged.
       */
      stopComputer: admin.dozoAdmin.stopComputer.handler(async ({ context, input }) => {
        const owner = await runAsSystem("find a computer's owner for the admin page", async () => {
          const bot = await prisma.bot.findFirst({
            // Only what the page lists: a hosted computer that is running.
            where: { computerId: input.computerId, archivedAt: null, computer: hosted },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              userId: true,
              spaceId: true,
              computer: { select: { controlUserId: true } },
            },
          });
          if (!bot) return null;
          const holder = bot.computer?.controlUserId;
          const users = await prisma.user.findMany({
            where: { id: { in: [holder ?? bot.userId, bot.userId] } },
            select: { id: true, email: true },
          });
          const user =
            users.find((user) => user.id === holder) ??
            users.find((user) => user.id === bot.userId);
          return user && { botId: bot.id, spaceId: bot.spaceId, user };
        });
        if (!owner) throw new ClientError("NOT_FOUND", "Computer not found");
        await createRouterClient(computerRoutes(ctx), {
          context: {
            actor: {
              userId: owner.user.id,
              spaceId: owner.spaceId,
              email: owner.user.email,
              isDeploymentOwner: false,
            },
            signal: context.signal,
          },
        }).computer.stop({ botId: owner.botId });
        getLogger().info("dozo.admin.computer_stop", {
          "admin.id": context.actor.userId,
          "computer.id": input.computerId,
        });
        return { ok: true as const };
      }),

      billing: dozoAdminBillingRoutes(ctx, wiring?.payments),
      funnel: dozoAdminFunnelRoutes(ctx),
      plans: dozoAdminPlansRoutes(ctx, wiring?.payments),
      accessGrants: dozoAdminAccessRoutes(ctx),
    },
  };
}

/**
 * The name the router imports: upstream's routes, plus the admin page's, the cache share and the
 * apps' product events.
 */
export function spendingLimitRoutes(ctx: RouterContext) {
  return {
    ...upstreamSpendingLimitRoutes(ctx),
    ...dozoAdminRoutes(ctx),
    ...dozoUsageRoutes(ctx),
    ...dozoEventsRoutes(ctx),
  };
}
