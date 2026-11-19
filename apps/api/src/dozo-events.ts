import type { BillingSubscriptionSnapshot, ProductAnalytics } from "@rakazo/adapter-kit";
import type { DozoPaymentLedger } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import { isOwnerRole } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { BillingService } from "./billing.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The fork's product events (`DOZO_ANALYTICS_EVENTS`). Each is reported after the work it
 * describes and never holds it up; without analytics configured nothing is read or sent. Each
 * carries an id the analytics provider deduplicates on, since the same change can be seen twice.
 */

/** How long a sign-up form may have been open before the account it made. */
export const DOZO_SIGNUP_FORM_MS = 60 * 60 * 1000;
/** How far back a payment webhook looks for refunds. */
export const DOZO_REFUND_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const FAILED = ["past_due", "unpaid"];

type Deps = { prisma: PrismaClient; analytics?: ProductAnalytics };

/** What the apps report: checked, then sent as the caller's own. */
export function dozoEventsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoEvents: {
      track: authed.dozoEvents.track.handler(async ({ context, input }) => {
        const { analytics, prisma } = deps;
        const userId = context.actor.userId;
        if (!analytics) return { ok: true as const };
        if (input.name !== "signup_started") {
          analytics.capture(userId, input);
          return { ok: true as const };
        }
        // Only a form opened shortly before this account was made started it.
        const startedAt = new Date(input.startedAt);
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { createdAt: true },
        });
        const before = user ? user.createdAt.getTime() - startedAt.getTime() : -1;
        if (before >= 0 && before <= DOZO_SIGNUP_FORM_MS)
          analytics.capture(userId, { name: "signup_started" }, { id: userId, at: startedAt });
        return { ok: true as const };
      }),
    },
  };
}

/** After a bot is created: the first one its creator ever made that still exists. */
export async function dozoFirstBot(deps: Deps, actor: Actor, botId: string): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first bot analytics",
    (async () => {
      const other = await prisma.bot.findFirst({
        where: { userId: actor.userId, id: { not: botId } },
        select: { id: true },
      });
      if (!other)
        analytics.capture(
          actor.userId,
          { name: "first_bot_created" },
          { id: actor.userId, at: new Date() },
        );
    })(),
  );
}

/**
 * After a member's message is saved: the first they wrote in this Space. A member's messages are
 * looked up within the Space, which its threads index; a first message in a second Space carries
 * the same id, so the provider keeps one.
 */
export async function dozoFirstMessage(
  deps: Deps,
  actor: Actor,
  message: { id: string; createdAt: Date },
): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first message analytics",
    (async () => {
      const earlier = await prisma.message.findFirst({
        where: {
          role: "user",
          authorUserId: actor.userId,
          id: { not: message.id },
          thread: { spaceId: actor.spaceId },
        },
        select: { id: true },
      });
      if (!earlier)
        analytics.capture(
          actor.userId,
          { name: "first_message_sent" },
          { id: actor.userId, at: message.createdAt },
        );
    })(),
  );
}

async function ownerOf(prisma: PrismaClient, organizationId: string) {
  const members = await prisma.member.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, role: true },
  });
  return members.find((member) => isOwnerRole(member.role))?.userId;
}

/**
 * After a billing sync recorded a subscription's change: a payment that failed, or a
 * subscription set to end. Called inside the sync's own reporting, whose failure it shares.
 */
export async function dozoBillingChange(
  deps: Deps,
  previous: BillingAccount,
  live: BillingSubscriptionSnapshot,
): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  const same = previous.subscriptionId === live.subscriptionId;
  const failed = FAILED.includes(live.status) && !(same && FAILED.includes(previous.status ?? ""));
  const endsLater = live.cancelAtPeriodEnd && !(same && previous.cancelAtPeriodEnd);
  const endedNow =
    live.status === "canceled" &&
    !(same && (previous.status === "canceled" || previous.cancelAtPeriodEnd));
  if (!failed && !endsLater && !endedNow) return;
  const owner = await ownerOf(prisma, previous.organizationId);
  if (!owner) return;
  const now = new Date();
  if (failed)
    analytics.capture(
      owner,
      { name: "payment_failed" },
      { id: `${live.subscriptionId}:${live.currentPeriodStartsAt?.toISOString()}`, at: now },
    );
  if (endsLater || endedNow)
    analytics.capture(
      owner,
      { name: "subscription_canceled", atPeriodEnd: endsLater },
      { id: live.subscriptionId, at: endedNow ? (live.endedAt ?? now) : now },
    );
}

/**
 * The billing service the payment webhook syncs through, which also reports the refunds the
 * payment provider recorded for that payer lately. Unchanged without analytics or a ledger.
 */
export function dozoRefundReports(
  billing: BillingService,
  deps: Deps & { ledger?: DozoPaymentLedger },
): BillingService {
  const { analytics, ledger, prisma } = deps;
  if (!analytics || !ledger) return billing;
  async function report(customerId: string) {
    const account = await prisma.billingAccount.findUnique({
      where: { customerId },
      select: { organizationId: true, subscriptionId: true },
    });
    if (!account) return;
    const to = new Date();
    const { entries } = await ledger!.read(
      { from: new Date(to.getTime() - DOZO_REFUND_LOOKBACK_MS), to },
      {
        customers: new Set([customerId]),
        subscriptions: new Set(account.subscriptionId ? [account.subscriptionId] : []),
      },
    );
    const refunds = entries.filter((entry) => entry.status === "refunded");
    if (refunds.length === 0) return;
    const owner = await ownerOf(prisma, account.organizationId);
    if (!owner) return;
    for (const refund of refunds)
      analytics!.capture(
        owner,
        { name: "refund_issued" },
        { id: `${customerId}:${refund.at.toISOString()}`, at: refund.at },
      );
  }
  return {
    ...billing,
    async sync(customerId) {
      await billing.sync(customerId);
      await bestEffort("refund analytics", report(customerId));
    },
  };
}
