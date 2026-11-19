import type { BillingSubscriptionSnapshot, ProductAnalytics } from "@rakazo/adapter-kit";
import type { DozoPaymentLedger } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import { isOwnerRole, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { BillingService } from "./billing.js";
import type { RouterContext } from "./routes/context.js";
import { windowCounter } from "./window-counter.js";

/**
 * The fork's product events (`DOZO_ANALYTICS_EVENTS`). Each is reported after the work it
 * describes and never holds it up; without analytics configured nothing is read or sent. Each
 * carries an id the analytics provider deduplicates on, since the same change can be seen twice.
 */

/** How long a sign-up form may have been open before the account it made. */
export const DOZO_SIGNUP_FORM_MS = 60 * 60 * 1000;
/** How far back a payment webhook looks for refunds. */
export const DOZO_REFUND_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
/** How long a refund read after a webhook may take; the webhook never waits for it. */
export const DOZO_REFUND_READ_MS = 10_000;
/** What one member's apps may report per minute; past it the report is refused. */
export const DOZO_EVENTS_PER_MINUTE = 30;
/** The same report from the same member within this window is sent once. */
export const DOZO_EVENT_REPEAT_MS = 10 * 60_000;
/** How many members this process remembers as already having their first bot or message. */
export const DOZO_FIRSTS_REMEMBERED = 10_000;
const FAILED = ["past_due", "unpaid"];

type Deps = { prisma: PrismaClient; analytics?: ProductAnalytics };

/**
 * What the apps report: checked, then sent as the caller's own. Each process limits how many one
 * member reports a minute and sends a repeated report once per window; with several instances
 * the limit is per instance.
 */
export function dozoEventsRoutes(ctx: RouterContext, now: () => number = Date.now) {
  const { deps, authed } = ctx;
  const perMinute = windowCounter(60_000, now);
  const repeats = windowCounter(DOZO_EVENT_REPEAT_MS, now);
  return {
    dozoEvents: {
      track: authed.dozoEvents.track.handler(async ({ context, input }) => {
        const { analytics, prisma } = deps;
        const userId = context.actor.userId;
        if (!analytics) return { ok: true as const };
        if (perMinute(`user:${userId}`) > DOZO_EVENTS_PER_MINUTE)
          throw new ClientError("TOO_MANY_REQUESTS", "Too many events");
        // A sign-up start is one per account whatever time it carries.
        const repeat = input.name === "signup_started" ? input.name : JSON.stringify(input);
        if (repeats(`${userId}:${repeat}`) > 1) return { ok: true as const };
        if (input.name !== "signup_started") {
          analytics.capture(userId, input);
          return { ok: true as const };
        }
        // Only a form opened shortly before this account was made started it.
        const opened = new Date(input.startedAt);
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { createdAt: true },
        });
        const before = user ? user.createdAt.getTime() - opened.getTime() : -1;
        if (before >= 0 && before <= DOZO_SIGNUP_FORM_MS)
          analytics.capture(userId, { name: "signup_started" }, { id: userId, at: opened });
        return { ok: true as const };
      }),
    },
  };
}

type FirstKind = "bot" | "message";
const remembered = new Set<string>();

/**
 * Records that the member made their first of a kind, once: true only for the call whose insert
 * added the row, however many race. A member this process saw recorded is not asked again, so a
 * member's later messages cost nothing.
 */
async function recordFirst(prisma: PrismaClient, userId: string, kind: FirstKind) {
  const key = `${kind}:${userId}`;
  if (remembered.has(key)) return false;
  const added = await runAsSystem(
    `record a member's first ${kind}`,
    () =>
      prisma.$executeRaw`
      INSERT INTO dozo_member_firsts ("userId", "kind") VALUES (${userId}, ${kind})
      ON CONFLICT DO NOTHING`,
  );
  // Oldest first: past the limit the member remembered longest is asked again next time.
  if (remembered.size >= DOZO_FIRSTS_REMEMBERED)
    remembered.delete(remembered.values().next().value!);
  remembered.add(key);
  return added === 1;
}

/** Forgets every member this process remembered; for tests. */
export function forgetRecordedFirsts() {
  remembered.clear();
}

/** After a bot is created: reports the member's first, once. */
export async function dozoFirstBot(deps: Deps, actor: Actor): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first bot analytics",
    (async () => {
      if (await recordFirst(prisma, actor.userId, "bot"))
        analytics.capture(
          actor.userId,
          { name: "first_bot_created" },
          { id: actor.userId, at: new Date() },
        );
    })(),
  );
}

/**
 * Bot creation that reports the member's first bot: every path that creates one goes through the
 * repositories this wraps (the app's own, templates, imports, copies, account import).
 */
export function dozoReportingRepos<
  R extends { createBot(actor: Actor, ...rest: never[]): Promise<unknown> },
>(repos: R, deps: Deps): R {
  if (!deps.analytics) return repos;
  return {
    ...repos,
    async createBot(actor: Actor, ...rest: never[]) {
      const bot = await repos.createBot(actor, ...rest);
      void dozoFirstBot(deps, actor);
      return bot;
    },
  };
}

/** After a member's message is saved: reports their first, once. */
export async function dozoFirstMessage(
  deps: Deps,
  actor: Actor,
  message: { createdAt: Date },
): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first message analytics",
    (async () => {
      if (await recordFirst(prisma, actor.userId, "message"))
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
  // The row as it was before this change: two syncs that see the same change share it, and a
  // later failure or cancellation of the same subscription has another.
  const change = `${live.subscriptionId}:${previous.updatedAt.toISOString()}`;
  if (failed) analytics.capture(owner, { name: "payment_failed" }, { id: change, at: now });
  if (endsLater || endedNow)
    analytics.capture(
      owner,
      { name: "subscription_canceled", atPeriodEnd: endsLater },
      { id: change, at: endedNow ? (live.endedAt ?? now) : now },
    );
}

/**
 * The billing service the payment webhook syncs through, which also reports the refunds the
 * payment provider recorded for that payer lately, in the background and for a short while at
 * most. Unchanged without analytics or a ledger.
 */
export function dozoRefundReports(
  billing: BillingService,
  deps: Deps & { ledger?: DozoPaymentLedger },
): BillingService {
  const { analytics, ledger, prisma } = deps;
  if (!analytics || !ledger) return billing;
  async function report(customerId: string, signal: AbortSignal) {
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
      signal,
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
      // After the sync is saved, without holding up the webhook's answer.
      void bestEffort("refund analytics", report(customerId, deadlineSignal(DOZO_REFUND_READ_MS)));
    },
  };
}
