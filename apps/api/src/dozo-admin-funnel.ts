import type {
  DozoAdminFunnel,
  DozoFunnelDays,
  DozoFunnelRow,
  DozoFunnelStep,
} from "@rakazo/contracts";
import { DOZO_FUNNEL_STEPS } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import { Prisma, runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A count is reused this long, so reloading or switching back to a period reads nothing. */
export const DOZO_FUNNEL_CACHE_MS = 60_000;

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

type FirstRow = { id: string; at: Date };

/** The first time per member, from rows of a member and a time. */
function firstTimes(rows: FirstRow[]) {
  return new Map(rows.map((row) => [row.id, row.at]));
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

  const cache = new Map<DozoFunnelDays, { until: number; value: Promise<DozoAdminFunnel> }>();

  async function readFunnel(days: DozoFunnelDays) {
    const from = new Date(Date.now() - days * DAY_MS);
    // Chat-app contacts are internal rows with no sign-in; members are people. Every read joins
    // the period's members instead of listing their ids.
    const cohort = Prisma.sql`u."createdAt" >= ${from} AND u.email NOT LIKE ${`%${MESSAGING_EMAIL_SUFFIX}`}`;
    const owner = Prisma.sql`'owner' = ANY (string_to_array(replace(m.role, ' ', ''), ','))`;
    const [members, credentials, bots, messages, paid, granted] = await Promise.all([
      prisma.$queryRaw<{ id: string; createdAt: Date }[]>`
        SELECT u.id, u."createdAt" FROM "user" u WHERE ${cohort}`,
      prisma.$queryRaw<FirstRow[]>`
        SELECT c."userId" AS id, min(c."createdAt") AS at
        FROM user_model_credentials c JOIN "user" u ON u.id = c."userId"
        WHERE ${cohort} GROUP BY c."userId"`,
      prisma.$queryRaw<FirstRow[]>`
        SELECT b."userId" AS id, min(b."createdAt") AS at
        FROM bots b JOIN "user" u ON u.id = b."userId"
        WHERE ${cohort} GROUP BY b."userId"`,
      // One probe per member of dozo_messages_author_idx, never a pass over every message.
      prisma.$queryRaw<FirstRow[]>`
        SELECT u.id, f.at FROM "user" u CROSS JOIN LATERAL (
          SELECT m."createdAt" AS at FROM messages m
          WHERE m."authorUserId" = u.id AND m.role = 'user'
          ORDER BY m."createdAt" LIMIT 1
        ) f
        WHERE ${cohort}`,
      prisma.$queryRaw<FirstRow[]>`
        SELECT m."userId" AS id, min(b."paidAt") AS at
        FROM member m
        JOIN billing_accounts b ON b."organizationId" = m."organizationId"
        JOIN "user" u ON u.id = m."userId"
        WHERE b."paidAt" IS NOT NULL AND ${owner} AND ${cohort} GROUP BY m."userId"`,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT m."userId" AS id
        FROM member m
        JOIN dozo_plan_grants g ON g."organizationId" = m."organizationId"
        JOIN "user" u ON u.id = m."userId"
        WHERE ${owner} AND ${cohort}`,
    ]);
    return funnelOf(
      {
        members,
        reached: {
          modelConnected: firstTimes(credentials),
          firstBot: firstTimes(bots),
          firstMessage: firstTimes(messages),
          paid: firstTimes(paid),
        },
        granted: new Set(granted.map((row) => row.id)),
      },
      days,
    );
  }

  return {
    read: admin.dozoAdmin.funnel.read.handler(({ input }) => {
      const cached = cache.get(input.days);
      if (cached && cached.until > Date.now()) return cached.value;
      const value = runAsSystem("count the sign-up funnel for the admin page", () =>
        readFunnel(input.days),
      );
      cache.set(input.days, { until: Date.now() + DOZO_FUNNEL_CACHE_MS, value });
      // A failed read is not kept: the next load asks again.
      value.catch(() => cache.delete(input.days));
      return value;
    }),
  };
}
