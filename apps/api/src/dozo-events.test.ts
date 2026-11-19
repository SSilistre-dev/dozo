import { createRouterClient } from "@orpc/server";
import type { BillingSubscriptionSnapshot, ProductAnalytics } from "@rakazo/adapter-kit";
import type { DozoLedgerEntry, DozoPaymentLedger } from "@rakazo/adapters";
import { AnalyticsEvent } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { BillingService } from "./billing.js";
import {
  DOZO_REFUND_LOOKBACK_MS,
  DOZO_SIGNUP_FORM_MS,
  dozoBillingChange,
  dozoEventsRoutes,
  dozoFirstBot,
  dozoFirstMessage,
  dozoRefundReports,
} from "./dozo-events.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const actor = { userId: "ada", spaceId: "space-ada", email: "", isDeploymentOwner: false };
const createdAt = new Date("2026-11-19T12:00:00.000Z");

function analytics() {
  return { capture: vi.fn(), flush: vi.fn() } satisfies ProductAnalytics;
}

describe("the event schema", () => {
  it("takes the fork's events with fixed values only", () => {
    for (const event of [
      { name: "signup_started" },
      { name: "first_bot_created" },
      { name: "first_message_sent" },
      { name: "plan_limit_hit", kind: "shared_space_full" },
      { name: "upgrade_viewed", source: "landing" },
      { name: "plan_intent", plan: "pro", period: "year" },
      { name: "payment_failed" },
      { name: "subscription_canceled", atPeriodEnd: true },
      { name: "refund_issued" },
    ])
      expect(AnalyticsEvent.safeParse(event).success).toBe(true);
    // Upstream's own events are unchanged.
    expect(AnalyticsEvent.safeParse({ name: "message_sent", trigger: "user" }).success).toBe(true);
    // Nothing that could carry personal data gets through.
    expect(AnalyticsEvent.safeParse({ name: "first_message_sent", text: "hello" }).success).toBe(
      false,
    );
    expect(
      AnalyticsEvent.safeParse({ name: "plan_limit_hit", kind: "COMPUTERS_BUSY" }).success,
    ).toBe(false);
  });
});

describe("the apps' reports", () => {
  function setup(sink?: ProductAnalytics) {
    const prisma = { user: { findUnique: vi.fn(async () => ({ createdAt })) } };
    const deps = { prisma, ...(sink ? { analytics: sink } : {}) } as unknown as RouterDeps;
    const client = createRouterClient(dozoEventsRoutes(createRouterContext(deps)), {
      context: { actor },
    });
    return { prisma, track: client.dozoEvents.track };
  }

  it("sends nothing, and reads nothing, without analytics", async () => {
    const { prisma, track } = setup();
    await expect(
      track({ name: "signup_started", startedAt: createdAt.toISOString() }),
    ).resolves.toEqual({ ok: true });
    await track({ name: "upgrade_viewed", source: "app" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("sends a report as the caller's own", async () => {
    const sink = analytics();
    const { track } = setup(sink);
    await track({ name: "plan_limit_hit", kind: "computer_hours" });
    await track({ name: "plan_intent", plan: "max", period: "month" });
    expect(sink.capture.mock.calls).toEqual([
      ["ada", { name: "plan_limit_hit", kind: "computer_hours" }],
      ["ada", { name: "plan_intent", plan: "max", period: "month" }],
    ]);
  });

  it("refuses what is not a fixed value", async () => {
    const { track } = setup(analytics());
    await expect(
      track({ name: "upgrade_viewed", source: "ada@example.test" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("takes a sign-up start only from within the hour before the account was made", async () => {
    const sink = analytics();
    const { track } = setup(sink);
    const opened = new Date(createdAt.getTime() - 5 * 60_000);
    await track({ name: "signup_started", startedAt: opened.toISOString() });
    // An hour and a millisecond before, and after the account: neither started it.
    const early = new Date(createdAt.getTime() - DOZO_SIGNUP_FORM_MS - 1);
    await track({ name: "signup_started", startedAt: early.toISOString() });
    const later = new Date(createdAt.getTime() + 1);
    await track({ name: "signup_started", startedAt: later.toISOString() });
    expect(sink.capture.mock.calls).toEqual([
      ["ada", { name: "signup_started" }, { id: "ada", at: opened }],
    ]);
  });

  it("drops a sign-up start for an account it cannot find", async () => {
    const sink = analytics();
    const { prisma, track } = setup(sink);
    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    await track({ name: "signup_started", startedAt: createdAt.toISOString() });
    expect(sink.capture).not.toHaveBeenCalled();
  });
});

describe("a first bot and a first message", () => {
  function prisma(found: { id: string } | null) {
    return {
      bot: { findFirst: vi.fn(async () => found) },
      message: { findFirst: vi.fn(async () => found) },
    };
  }

  it("is reported when the member has no other", async () => {
    const sink = analytics();
    const db = prisma(null);
    const deps = { prisma: db as unknown as PrismaClient, analytics: sink };
    await dozoFirstBot(deps, actor, "bot-1");
    await dozoFirstMessage(deps, actor, { id: "message-1", createdAt });
    expect(db.bot.findFirst).toHaveBeenCalledWith({
      where: { userId: "ada", id: { not: "bot-1" } },
      select: { id: true },
    });
    expect(db.message.findFirst).toHaveBeenCalledWith({
      where: {
        role: "user",
        authorUserId: "ada",
        id: { not: "message-1" },
        thread: { spaceId: "space-ada" },
      },
      select: { id: true },
    });
    expect(sink.capture.mock.calls).toEqual([
      ["ada", { name: "first_bot_created" }, { id: "ada", at: expect.any(Date) }],
      ["ada", { name: "first_message_sent" }, { id: "ada", at: createdAt }],
    ]);
  });

  it("is not reported after another, nor read without analytics, nor ever thrown", async () => {
    const sink = analytics();
    const db = prisma({ id: "older" });
    await dozoFirstBot({ prisma: db as unknown as PrismaClient, analytics: sink }, actor, "bot-2");
    await dozoFirstMessage({ prisma: db as unknown as PrismaClient, analytics: sink }, actor, {
      id: "message-2",
      createdAt,
    });
    expect(sink.capture).not.toHaveBeenCalled();

    const quiet = prisma(null);
    await dozoFirstBot({ prisma: quiet as unknown as PrismaClient }, actor, "bot-3");
    await dozoFirstMessage({ prisma: quiet as unknown as PrismaClient }, actor, {
      id: "message-3",
      createdAt,
    });
    expect(quiet.bot.findFirst).not.toHaveBeenCalled();
    expect(quiet.message.findFirst).not.toHaveBeenCalled();

    const broken = {
      bot: { findFirst: vi.fn(async () => Promise.reject(new Error("down"))) },
      message: { findFirst: vi.fn(async () => Promise.reject(new Error("down"))) },
    } as unknown as PrismaClient;
    await expect(dozoFirstBot({ prisma: broken, analytics: sink }, actor, "b")).resolves.toBe(
      undefined,
    );
    await expect(
      dozoFirstMessage({ prisma: broken, analytics: sink }, actor, { id: "m", createdAt }),
    ).resolves.toBe(undefined);
  });
});

const owners = [
  { userId: "teammate", role: "member" },
  { userId: "ada", role: "owner" },
];
function ownerDb(rows = owners) {
  return { member: { findMany: vi.fn(async () => rows) } };
}

function account(more: Partial<BillingAccount> = {}): BillingAccount {
  return {
    organizationId: "org-ada",
    subscriptionId: "sub-1",
    status: "active",
    cancelAtPeriodEnd: false,
    ...more,
  } as BillingAccount;
}

function snapshot(more: Partial<BillingSubscriptionSnapshot> = {}): BillingSubscriptionSnapshot {
  return {
    subscriptionId: "sub-1",
    subscriptionItemId: "item-1",
    priceId: "price-1",
    status: "active",
    seats: 1,
    trialEndsAt: null,
    currentPeriodStartsAt: createdAt,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    endedAt: null,
    ...more,
  };
}

describe("a billing change", () => {
  async function change(
    previous: BillingAccount,
    live: BillingSubscriptionSnapshot,
    db = ownerDb(),
  ) {
    const sink = analytics();
    await dozoBillingChange(
      { prisma: db as unknown as PrismaClient, analytics: sink },
      previous,
      live,
    );
    return sink.capture.mock.calls;
  }

  it("reports a payment that failed once, to the owner", async () => {
    expect(await change(account(), snapshot({ status: "past_due" }))).toEqual([
      [
        "ada",
        { name: "payment_failed" },
        { id: `sub-1:${createdAt.toISOString()}`, at: expect.any(Date) },
      ],
    ]);
    // Still failing, now unpaid: already reported.
    expect(await change(account({ status: "past_due" }), snapshot({ status: "unpaid" }))).toEqual(
      [],
    );
    // A new subscription that fails is reported again.
    expect(
      await change(
        account({ status: "past_due" }),
        snapshot({ subscriptionId: "sub-2", status: "unpaid" }),
      ),
    ).toHaveLength(1);
  });

  it("reports a subscription set to end, at the period's end or at once", async () => {
    expect(await change(account(), snapshot({ cancelAtPeriodEnd: true }))).toEqual([
      [
        "ada",
        { name: "subscription_canceled", atPeriodEnd: true },
        { id: "sub-1", at: expect.any(Date) },
      ],
    ]);
    const ended = new Date(createdAt.getTime() + 1000);
    expect(await change(account(), snapshot({ status: "canceled", endedAt: ended }))).toEqual([
      ["ada", { name: "subscription_canceled", atPeriodEnd: false }, { id: "sub-1", at: ended }],
    ]);
    // Ending at the period's end, as already reported, and an end with no time.
    expect(
      await change(
        account({ cancelAtPeriodEnd: true }),
        snapshot({ status: "canceled", cancelAtPeriodEnd: true }),
      ),
    ).toEqual([]);
    expect(await change(account({ status: "canceled" }), snapshot({ status: "canceled" }))).toEqual(
      [],
    );
    expect(await change(account(), snapshot({ status: "canceled" }))).toEqual([
      [
        "ada",
        { name: "subscription_canceled", atPeriodEnd: false },
        { id: "sub-1", at: expect.any(Date) },
      ],
    ]);
  });

  it("reports nothing without a change, an owner or analytics", async () => {
    const db = ownerDb();
    expect(await change(account(), snapshot(), db)).toEqual([]);
    expect(db.member.findMany).not.toHaveBeenCalled();
    expect(
      await change(account({ status: null }), snapshot({ status: "past_due" }), ownerDb([])),
    ).toEqual([]);
    await dozoBillingChange(
      { prisma: db as unknown as PrismaClient },
      account(),
      snapshot({ status: "past_due" }),
    );
    expect(db.member.findMany).not.toHaveBeenCalled();
  });
});

describe("refunds after a payment webhook", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  function entry(status: DozoLedgerEntry["status"], at: Date): DozoLedgerEntry {
    return { customerId: "cus-ada", amount: 900, currency: "usd", at, status };
  }
  function setup(entries: DozoLedgerEntry[], found = true) {
    const sink = analytics();
    const billing = {
      sync: vi.fn(async () => {}),
      reportPartnerSales: vi.fn(async () => {}),
    } as unknown as BillingService;
    const db = {
      ...ownerDb(),
      billingAccount: {
        findUnique: vi.fn(async () =>
          found ? { organizationId: "org-ada", subscriptionId: "sub-1" } : null,
        ),
      },
    };
    const ledger = { read: vi.fn(async () => ({ entries, unclassified: 0, partial: false })) };
    const wrapped = dozoRefundReports(billing, {
      prisma: db as unknown as PrismaClient,
      analytics: sink,
      ledger,
    });
    return { sink, billing, db, ledger, wrapped };
  }

  it("is the service itself without analytics or a payment ledger", () => {
    const billing = { sync: vi.fn() } as unknown as BillingService;
    const ledger = { read: vi.fn() } satisfies DozoPaymentLedger;
    const prisma = {} as PrismaClient;
    expect(dozoRefundReports(billing, { prisma, ledger })).toBe(billing);
    expect(dozoRefundReports(billing, { prisma, analytics: analytics() })).toBe(billing);
  });

  it("syncs first, then reports each recent refund of the payer to its owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const refundedAt = new Date(now.getTime() - 60_000);
    const { sink, billing, ledger, wrapped } = setup([
      entry("paid", new Date(now.getTime() - 120_000)),
      entry("refunded", refundedAt),
    ]);
    await wrapped.sync("cus-ada");
    vi.useRealTimers();
    expect(billing.sync).toHaveBeenCalledWith("cus-ada");
    expect(ledger.read).toHaveBeenCalledWith(
      { from: new Date(now.getTime() - DOZO_REFUND_LOOKBACK_MS), to: now },
      { customers: new Set(["cus-ada"]), subscriptions: new Set(["sub-1"]) },
    );
    expect(sink.capture.mock.calls).toEqual([
      [
        "ada",
        { name: "refund_issued" },
        { id: `cus-ada:${refundedAt.toISOString()}`, at: refundedAt },
      ],
    ]);
    // Everything else is the service's own.
    await wrapped.reportPartnerSales("cus-ada");
    expect(billing.reportPartnerSales).toHaveBeenCalledWith("cus-ada");
  });

  it("reports nothing for an unknown payer, without refunds, or when the read fails", async () => {
    const unknown = setup([entry("refunded", now)], false);
    await unknown.wrapped.sync("cus-x");
    expect(unknown.ledger.read).not.toHaveBeenCalled();

    const none = setup([entry("paid", now)]);
    await none.wrapped.sync("cus-ada");
    expect(none.db.member.findMany).not.toHaveBeenCalled();

    const failing = setup([]);
    failing.ledger.read.mockRejectedValueOnce(new Error("provider down"));
    await expect(failing.wrapped.sync("cus-ada")).resolves.toBe(undefined);

    const ownerless = setup([entry("refunded", now)]);
    ownerless.db.member.findMany.mockResolvedValueOnce([]);
    await ownerless.wrapped.sync("cus-ada");
    expect(ownerless.sink.capture).not.toHaveBeenCalled();
    for (const run of [unknown, none, failing]) expect(run.sink.capture).not.toHaveBeenCalled();
  });

  it("reads a payer without a subscription with no subscriptions", async () => {
    const run = setup([]);
    run.db.billingAccount.findUnique.mockResolvedValueOnce({
      organizationId: "org-ada",
      subscriptionId: null,
    } as never);
    await run.wrapped.sync("cus-ada");
    expect(run.ledger.read).toHaveBeenCalledWith(expect.anything(), {
      customers: new Set(["cus-ada"]),
      subscriptions: new Set(),
    });
  });
});
