import { createRouterClient } from "@orpc/server";
import type { BillingSubscriptionSnapshot, ProductAnalytics } from "@rakazo/adapter-kit";
import type { DozoLedger, DozoLedgerEntry, DozoPaymentLedger } from "@rakazo/adapters";
import { AnalyticsEvent } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingService } from "./billing.js";
import {
  DOZO_EVENT_REPEAT_MS,
  DOZO_EVENTS_PER_MINUTE,
  DOZO_FIRSTS_REMEMBERED,
  DOZO_REFUND_LOOKBACK_MS,
  DOZO_SIGNUP_FORM_MS,
  dozoBillingChange,
  dozoEventsRoutes,
  dozoFirstBot,
  dozoFirstMessage,
  dozoRefundReports,
  dozoReportingRepos,
  forgetRecordedFirsts,
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
  function setup(sink?: ProductAnalytics, clock = () => Date.now()) {
    const prisma = { user: { findUnique: vi.fn(async () => ({ createdAt })) } };
    const deps = { prisma, ...(sink ? { analytics: sink } : {}) } as unknown as RouterDeps;
    const client = createRouterClient(dozoEventsRoutes(createRouterContext(deps), clock), {
      context: { actor },
    });
    return { prisma, track: client.dozoEvents.track };
  }

  it("sends the same report once per window, and refuses a flood", async () => {
    let time = 0;
    const sink = analytics();
    const { track } = setup(sink, () => time);
    for (let index = 0; index < 5; index++) await track({ name: "upgrade_viewed", source: "app" });
    await track({ name: "upgrade_viewed", source: "paywall" });
    expect(sink.capture).toHaveBeenCalledTimes(2);
    time = DOZO_EVENT_REPEAT_MS;
    await track({ name: "upgrade_viewed", source: "app" });
    expect(sink.capture).toHaveBeenCalledTimes(3);
    for (let index = 0; index < DOZO_EVENTS_PER_MINUTE; index++)
      await track({ name: "plan_limit_hit", kind: "computer_hours" }).catch((error) => error);
    await expect(
      track({ name: "plan_limit_hit", kind: "space_limit_reached" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(sink.capture).toHaveBeenCalledTimes(4);
  });

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
    const opened = new Date(createdAt.getTime() - 5 * 60_000);
    // An hour and a millisecond before, and after the account: neither started it.
    const early = new Date(createdAt.getTime() - DOZO_SIGNUP_FORM_MS - 1);
    const later = new Date(createdAt.getTime() + 1);
    const sent = [];
    for (const startedAt of [opened, early, later]) {
      const sink = analytics();
      await setup(sink).track({ name: "signup_started", startedAt: startedAt.toISOString() });
      sent.push(sink.capture.mock.calls);
    }
    expect(sent).toEqual([
      [["ada", { name: "signup_started" }, { id: "ada", at: opened }]],
      [],
      [],
    ]);
  });

  it("takes one sign-up start per account, whatever time a repeat carries", async () => {
    const sink = analytics();
    const { prisma, track } = setup(sink);
    await track({ name: "signup_started", startedAt: createdAt.toISOString() });
    await track({
      name: "signup_started",
      startedAt: new Date(createdAt.getTime() - 1).toISOString(),
    });
    expect(sink.capture).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
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
  /** The marks table: an insert adds a row only when the member has none of that kind. */
  function marks() {
    const rows = new Set<string>();
    return {
      rows,
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, userId: string, kind: string) => {
        const key = `${kind}:${userId}`;
        if (rows.has(key)) return 0;
        rows.add(key);
        return 1;
      }),
    };
  }
  beforeEach(() => forgetRecordedFirsts());

  it("is reported once per member, however many race, and never asked again after", async () => {
    const sink = analytics();
    const db = marks();
    const deps = { prisma: db as unknown as PrismaClient, analytics: sink };
    await Promise.all([dozoFirstBot(deps, actor), dozoFirstBot(deps, actor)]);
    await Promise.all([
      dozoFirstMessage(deps, actor, { createdAt }),
      dozoFirstMessage(deps, actor, { createdAt }),
    ]);
    expect(sink.capture.mock.calls).toEqual([
      ["ada", { name: "first_bot_created" }, { id: "ada", at: expect.any(Date) }],
      ["ada", { name: "first_message_sent" }, { id: "ada", at: createdAt }],
    ]);
    const asked = db.$executeRaw.mock.calls.length;
    await dozoFirstMessage(deps, actor, { createdAt });
    await dozoFirstBot(deps, actor);
    expect(db.$executeRaw).toHaveBeenCalledTimes(asked);
  });

  it("is not reported for a member already recorded, as the migration records earlier ones", async () => {
    const sink = analytics();
    const db = marks();
    db.rows.add("message:ada");
    await dozoFirstMessage({ prisma: db as unknown as PrismaClient, analytics: sink }, actor, {
      createdAt,
    });
    expect(sink.capture).not.toHaveBeenCalled();
  });

  it("forgets the longest remembered member past its limit", async () => {
    const db = marks();
    const deps = { prisma: db as unknown as PrismaClient, analytics: analytics() };
    for (let index = 0; index <= DOZO_FIRSTS_REMEMBERED; index++)
      await dozoFirstMessage(deps, { ...actor, userId: `user-${index}` }, { createdAt });
    const asked = db.$executeRaw.mock.calls.length;
    await dozoFirstMessage(deps, { ...actor, userId: "user-0" }, { createdAt });
    await dozoFirstMessage(
      deps,
      { ...actor, userId: `user-${DOZO_FIRSTS_REMEMBERED}` },
      { createdAt },
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(asked + 1);
  });

  it("reads nothing without analytics, and never throws", async () => {
    const quiet = marks();
    await dozoFirstBot({ prisma: quiet as unknown as PrismaClient }, actor);
    await dozoFirstMessage({ prisma: quiet as unknown as PrismaClient }, actor, { createdAt });
    expect(quiet.$executeRaw).not.toHaveBeenCalled();

    const broken = {
      $executeRaw: vi.fn(async () => Promise.reject(new Error("down"))),
    } as unknown as PrismaClient;
    const sink = analytics();
    await expect(dozoFirstBot({ prisma: broken, analytics: sink }, actor)).resolves.toBe(undefined);
    await expect(
      dozoFirstMessage({ prisma: broken, analytics: sink }, actor, { createdAt }),
    ).resolves.toBe(undefined);
    expect(sink.capture).not.toHaveBeenCalled();
  });

  it("reports a first bot from every creation that goes through the repositories", async () => {
    const sink = analytics();
    const db = marks();
    const repos = {
      createBot: vi.fn(async (_actor: typeof actor, input: { name: string }) => ({
        id: input.name,
      })),
      getBot: vi.fn(),
    };
    const wrapped = dozoReportingRepos(repos, {
      prisma: db as unknown as PrismaClient,
      analytics: sink,
    });
    expect(await wrapped.createBot(actor, { name: "first" })).toEqual({ id: "first" });
    expect(wrapped.getBot).toBe(repos.getBot);
    await vi.waitFor(() => expect(sink.capture).toHaveBeenCalledTimes(1));
    expect(repos.createBot).toHaveBeenCalledWith(actor, { name: "first" });
    // Without analytics the repositories are as they were.
    expect(dozoReportingRepos(repos, { prisma: db as unknown as PrismaClient })).toBe(repos);
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
    updatedAt: createdAt,
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
    // Paid again, then failing again in the same period: a new report, with its own id.
    const recovered = new Date(createdAt.getTime() + 60_000);
    expect(
      await change(account({ updatedAt: recovered }), snapshot({ status: "past_due" })),
    ).toEqual([
      [
        "ada",
        { name: "payment_failed" },
        { id: `sub-1:${recovered.toISOString()}`, at: expect.any(Date) },
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

  it("reports a cancellation again after it was taken back", async () => {
    const undone = new Date(createdAt.getTime() + 5_000);
    const first = await change(account(), snapshot({ cancelAtPeriodEnd: true }));
    const second = await change(
      account({ updatedAt: undone }),
      snapshot({ cancelAtPeriodEnd: true }),
    );
    expect(first[0]?.[2]).toEqual({ id: `sub-1:${createdAt.toISOString()}`, at: expect.any(Date) });
    expect(second[0]?.[2]).toEqual({ id: `sub-1:${undone.toISOString()}`, at: expect.any(Date) });
  });

  it("reports a subscription set to end, at the period's end or at once", async () => {
    expect(await change(account(), snapshot({ cancelAtPeriodEnd: true }))).toEqual([
      [
        "ada",
        { name: "subscription_canceled", atPeriodEnd: true },
        { id: `sub-1:${createdAt.toISOString()}`, at: expect.any(Date) },
      ],
    ]);
    const ended = new Date(createdAt.getTime() + 1000);
    expect(await change(account(), snapshot({ status: "canceled", endedAt: ended }))).toEqual([
      [
        "ada",
        { name: "subscription_canceled", atPeriodEnd: false },
        { id: `sub-1:${createdAt.toISOString()}`, at: ended },
      ],
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
        { id: `sub-1:${createdAt.toISOString()}`, at: expect.any(Date) },
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
    const ledger = {
      read: vi.fn(
        async (..._args: unknown[]): Promise<DozoLedger> => ({
          entries,
          unclassified: 0,
          partial: false,
        }),
      ),
    };
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

  it("answers the webhook once synced, then reports each recent refund of the payer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const refundedAt = new Date(now.getTime() - 60_000);
    const run = setup([
      entry("paid", new Date(now.getTime() - 120_000)),
      entry("refunded", refundedAt),
    ]);
    const read = deferred<DozoLedger>();
    run.ledger.read.mockReturnValueOnce(read.promise);
    await run.wrapped.sync("cus-ada");
    vi.useRealTimers();
    // The answer did not wait for the read.
    expect(run.billing.sync).toHaveBeenCalledWith("cus-ada");
    await vi.waitFor(() => expect(run.ledger.read).toHaveBeenCalled());
    expect(run.sink.capture).not.toHaveBeenCalled();
    const [range, accounts, signal] = run.ledger.read.mock.calls[0]!;
    expect(range).toEqual({ from: new Date(now.getTime() - DOZO_REFUND_LOOKBACK_MS), to: now });
    expect(accounts).toEqual({
      customers: new Set(["cus-ada"]),
      subscriptions: new Set(["sub-1"]),
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    read.resolve({
      entries: [entry("paid", now), entry("refunded", refundedAt)],
      unclassified: 0,
      partial: false,
    });
    await vi.waitFor(() =>
      expect(run.sink.capture.mock.calls).toEqual([
        [
          "ada",
          { name: "refund_issued" },
          { id: `cus-ada:${refundedAt.toISOString()}`, at: refundedAt },
        ],
      ]),
    );
    // Everything else is the service's own.
    await run.wrapped.reportPartnerSales("cus-ada");
    expect(run.billing.reportPartnerSales).toHaveBeenCalledWith("cus-ada");
  });

  it("reports nothing for an unknown payer, without refunds, or when the read fails", async () => {
    const unknown = setup([entry("refunded", now)], false);
    await unknown.wrapped.sync("cus-x");
    await vi.waitFor(() => expect(unknown.db.billingAccount.findUnique).toHaveBeenCalled());
    await flush();
    expect(unknown.ledger.read).not.toHaveBeenCalled();

    const none = setup([entry("paid", now)]);
    await none.wrapped.sync("cus-ada");
    await vi.waitFor(() => expect(none.ledger.read).toHaveBeenCalled());
    await flush();
    expect(none.db.member.findMany).not.toHaveBeenCalled();

    const failing = setup([]);
    failing.ledger.read.mockRejectedValueOnce(new Error("provider down"));
    await expect(failing.wrapped.sync("cus-ada")).resolves.toBe(undefined);
    await vi.waitFor(() => expect(failing.ledger.read).toHaveBeenCalled());

    const ownerless = setup([entry("refunded", now)]);
    ownerless.db.member.findMany.mockResolvedValueOnce([]);
    await ownerless.wrapped.sync("cus-ada");
    await vi.waitFor(() => expect(ownerless.db.member.findMany).toHaveBeenCalled());
    await flush();
    for (const run of [unknown, none, failing, ownerless])
      expect(run.sink.capture).not.toHaveBeenCalled();
  });

  it("reads a payer without a subscription with no subscriptions", async () => {
    const run = setup([]);
    run.db.billingAccount.findUnique.mockResolvedValueOnce({
      organizationId: "org-ada",
      subscriptionId: null,
    } as never);
    await run.wrapped.sync("cus-ada");
    await vi.waitFor(() =>
      expect(run.ledger.read).toHaveBeenCalledWith(
        expect.anything(),
        { customers: new Set(["cus-ada"]), subscriptions: new Set() },
        expect.any(AbortSignal),
      ),
    );
  });
});
