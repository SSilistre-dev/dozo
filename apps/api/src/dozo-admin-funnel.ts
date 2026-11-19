import type {
  DozoAdminFunnel,
  DozoFunnelDays,
  DozoFunnelRow,
  DozoFunnelStep,
} from "@rakazo/contracts";
import { DOZO_FUNNEL_STEPS } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import { isOwnerRole, runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When each member of the period first reached each step after signing up. */
export interface FunnelInput {
  /** The members who signed up in the period, and when. */
  members: { id: string; createdAt: Date }[];
  /** Per step after sign-up: member id to the first time they reached it. */
  reached: Record<Exclude<DozoFunnelStep, "signedUp">, Map<string, Date>>;
  /** Members who own an organization an admin granted a plan to. */
  granted: Set<string>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * A member counts at a step once they reached it and every step before it, so each count is at
 * most the one before. The time of a step is measured from the step before; a step done earlier
 * than the one before it counts as no time. Anyone not among `members` is ignored.
 */
export function funnelOf(input: FunnelInput, days: DozoFunnelDays): DozoAdminFunnel {
  let previous = new Map(input.members.map((member) => [member.id, member.createdAt]));
  const steps: DozoFunnelRow[] = [
    { step: "signedUp", members: previous.size, rate: null, medianSeconds: null },
  ];
  for (const step of DOZO_FUNNEL_STEPS.slice(1) as Exclude<DozoFunnelStep, "signedUp">[]) {
    const current = new Map<string, Date>();
    const waits: number[] = [];
    for (const [id, before] of previous) {
      const at = input.reached[step].get(id);
      if (!at) continue;
      current.set(id, at);
      waits.push(Math.max(0, at.getTime() - before.getTime()));
    }
    const wait = median(waits);
    steps.push({
      step,
      members: current.size,
      rate: previous.size ? Math.round((current.size * 100) / previous.size) : null,
      medianSeconds: wait === null ? null : Math.round(wait / 1000),
    });
    previous = current;
  }
  const paid = input.reached.paid;
  const members = new Set(input.members.map((member) => member.id));
  const granted = [...input.granted].filter((id) => members.has(id) && !paid.has(id)).length;
  return { days, steps, granted };
}

/** The first time per member, from `groupBy` rows with `_min.createdAt`. */
function firstTimes(rows: [string | null, Date | null][]) {
  const times = new Map<string, Date>();
  for (const [id, at] of rows) if (id && at) times.set(id, at);
  return times;
}

/**
 * The admin funnel page: members who signed up in the period and how far they got, counted from
 * the deployment's own records. Refused unless the caller is a deployment admin.
 *
 * - Model connected: the member's oldest model connection still saved.
 * - First bot: the oldest bot they created that still exists, archived ones included.
 * - First message: the oldest message they wrote that still exists.
 * - Paid: the first payment of a subscription of an organization they own (`paidAt`). A plan an
 *   admin granted is not a payment and is counted on its own.
 *
 * A deleted account is gone from every step. A suspended one still counts: it did sign up.
 */
export function dozoAdminFunnelRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    return next();
  });

  async function readFunnel(days: DozoFunnelDays) {
    const from = new Date(Date.now() - days * DAY_MS);
    const members = await prisma.user.findMany({
      // Chat-app contacts are internal rows with no sign-in; members are people.
      where: { createdAt: { gte: from }, NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } },
      select: { id: true, createdAt: true },
    });
    const ids = members.map((member) => member.id);
    const [credentials, bots, messages, owned] = await Promise.all([
      prisma.userModelCredential.groupBy({
        by: ["userId"],
        where: { userId: { in: ids } },
        _min: { createdAt: true },
      }),
      prisma.bot.groupBy({
        by: ["userId"],
        where: { userId: { in: ids } },
        _min: { createdAt: true },
      }),
      prisma.message.groupBy({
        by: ["authorUserId"],
        where: { authorUserId: { in: ids }, role: "user" },
        _min: { createdAt: true },
      }),
      prisma.member.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, organizationId: true, role: true },
      }),
    ]);
    const ownerOf = new Map<string, string[]>();
    for (const membership of owned) {
      if (!isOwnerRole(membership.role)) continue;
      const owners = ownerOf.get(membership.organizationId) ?? [];
      ownerOf.set(membership.organizationId, [...owners, membership.userId]);
    }
    const organizations = [...ownerOf.keys()];
    const [payments, grants] = await Promise.all([
      prisma.billingAccount.findMany({
        where: { organizationId: { in: organizations }, paidAt: { not: null } },
        select: { organizationId: true, paidAt: true },
      }),
      prisma.dozoPlanGrant.findMany({
        where: { organizationId: { in: organizations } },
        select: { organizationId: true },
      }),
    ]);
    const paid = new Map<string, Date>();
    for (const payment of payments)
      for (const userId of ownerOf.get(payment.organizationId)!) {
        const earlier = paid.get(userId);
        // Read with `paidAt` set.
        if (!earlier || payment.paidAt! < earlier) paid.set(userId, payment.paidAt!);
      }
    return funnelOf(
      {
        members,
        reached: {
          modelConnected: firstTimes(credentials.map((row) => [row.userId, row._min.createdAt])),
          firstBot: firstTimes(bots.map((row) => [row.userId, row._min.createdAt])),
          firstMessage: firstTimes(messages.map((row) => [row.authorUserId, row._min.createdAt])),
          paid,
        },
        granted: new Set(grants.flatMap((grant) => ownerOf.get(grant.organizationId)!)),
      },
      days,
    );
  }

  return {
    read: admin.dozoAdmin.funnel.read.handler(({ input }) =>
      runAsSystem("count the sign-up funnel for the admin page", () => readFunnel(input.days)),
    ),
  };
}
