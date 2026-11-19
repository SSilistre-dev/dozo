import { createRouterClient } from "@orpc/server";
import type { DozoLedger, DozoLedgerEntry, DozoPaymentLedger } from "@rakazo/adapters";
import { hasBillingAccess } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { BillingRow, SummaryInput } from "./dozo-admin-billing.js";
import {
  billingSummary,
  DOZO_ADMIN_LIVE_STATUSES,
  DOZO_ADMIN_RECENT_PAYMENTS,
  DOZO_ADMIN_REVENUE_CACHE_MS,
  dozoAdminBillingRoutes,
  revenueOf,
  revenueRange,
} from "./dozo-admin-billing.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const now = new Date("2026-11-19T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(now.getTime() + days * day);

function billing(organizationId: string, more: Partial<BillingRow> = {}): BillingRow {
  return {
    organizationId,
    status: "active",
    byokTier: "pro",
    byokInterval: "month",
    trialEndsAt: null,
    currentPeriodEndsAt: inDays(20),
    cancelAtPeriodEnd: false,
    ...more,
  };
}

function input(more: Partial<SummaryInput>): SummaryInput {
  return { members: 0, statuses: [], live: [], grants: [], owned: new Map(), ...more };
}

describe("counting plans", () => {
  it("reads only the statuses that give the plan as live", () => {
    for (const status of DOZO_ADMIN_LIVE_STATUSES) expect(hasBillingAccess(status)).toBe(true);
  });

  it("counts each member by the organization they own: how it pays, a grant, or Free", () => {
    const summary = billingSummary(
      input({
        members: 10,
        live: [
          billing("org-monthly"),
          billing("org-yearly", { byokInterval: "year" }),
          billing("org-max", { byokTier: "max", byokInterval: "year" }),
          // Premium under a granted Premium Plus counts as the grant.
          billing("org-raised"),
          // Credits only: no own-model tier, so Free.
          billing("org-credits", { byokTier: null }),
          // A Free subscription is Free, counted by how it pays.
          billing("org-free", { byokTier: "standard" }),
        ],
        grants: [
          { organizationId: "org-raised", tier: "max", endsAt: inDays(60) },
          { organizationId: "org-gift", tier: "pro", endsAt: inDays(90) },
        ],
        owned: new Map([
          ["ada", "org-monthly"],
          ["bob", "org-yearly"],
          ["cy", "org-max"],
          ["dee", "org-raised"],
          ["eve", "org-credits"],
          ["fay", "org-gift"],
          ["gus", "org-free"],
          // A member of a paid team who owns a Free organization of their own is on Free.
          ["hal", "org-own"],
        ]),
      }),
      now,
    );
    expect(summary.members).toBe(10);
    expect(summary.granted).toBe(2);
    expect(summary.plans).toEqual([
      { tier: "standard", total: 5, monthly: 1, yearly: 0, granted: 0 },
      { tier: "pro", total: 3, monthly: 1, yearly: 1, granted: 1 },
      { tier: "max", total: 2, monthly: 0, yearly: 1, granted: 1 },
    ]);
  });

  it("counts subscriptions by status, cancellations and what ends soon, once per organization", () => {
    const summary = billingSummary(
      input({
        members: 4,
        statuses: [
          { status: "active", count: 7 },
          { status: "trialing", count: 2 },
          { status: "past_due", count: 1 },
          { status: "unpaid", count: 3 },
          { status: "canceled", count: 9 },
          { status: null, count: 4 },
        ],
        live: [
          billing("trial", { status: "trialing", trialEndsAt: inDays(3) }),
          billing("leaving", { cancelAtPeriodEnd: true, currentPeriodEndsAt: inDays(10) }),
          // Ends in 2 days by trial and in 40 by grant: counted once, by the soonest.
          billing("both", { status: "trialing", trialEndsAt: inDays(2) }),
          // A trial whose end already passed ends nothing.
          billing("stale", { status: "trialing", trialEndsAt: inDays(-1) }),
        ],
        grants: [
          { organizationId: "both", tier: "max", endsAt: inDays(40) },
          { organizationId: "later", tier: "pro", endsAt: inDays(45) },
        ],
      }),
      now,
    );
    expect(summary).toMatchObject({ paid: 7, trialing: 2, pastDue: 4, cancelling: 1 });
    expect(summary.ending).toEqual({ within7Days: 2, within30Days: 3 });
  });
});

describe("the revenue period", () => {
  it("covers this month so far, the whole last month, or the last twelve months", () => {
    expect(revenueRange("thisMonth", now)).toEqual({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: now,
    });
    expect(revenueRange("lastMonth", now)).toEqual({
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(revenueRange("last12Months", now)).toEqual({
      from: new Date("2025-11-19T12:00:00.000Z"),
      to: now,
    });
    // January's last month is December of the year before.
    expect(revenueRange("lastMonth", new Date("2027-01-05T00:00:00.000Z")).from).toEqual(
      new Date("2026-12-01T00:00:00.000Z"),
    );
  });
});

function entry(more: Partial<DozoLedgerEntry> = {}): DozoLedgerEntry {
  return { customerId: "cus_ada", amount: 1000, currency: "usd", at: now, status: "paid", ...more };
}

function ledgerOf(entries: DozoLedgerEntry[], more: Partial<DozoLedger> = {}): DozoLedger {
  return { entries, unclassified: 0, partial: false, ...more };
}

describe("summing payments", () => {
  it("totals each currency apart, counts failures and keeps the newest payments", () => {
    const entries = [
      entry(),
      entry({ amount: 500, status: "refunded" }),
      entry({ currency: "EUR", amount: 900 }),
      entry({ status: "failed" }),
      ...Array.from({ length: DOZO_ADMIN_RECENT_PAYMENTS }, () => entry({ amount: 1 })),
    ];
    const revenue = revenueOf(ledgerOf(entries, { unclassified: 2 }));
    expect(revenue.totals).toEqual([
      { currency: "usd", paid: 1000 + DOZO_ADMIN_RECENT_PAYMENTS, refunded: 500 },
      { currency: "eur", paid: 900, refunded: 0 },
    ]);
    expect(revenue.failed).toBe(1);
    expect(revenue.unclassified).toBe(2);
    expect(revenue.recent).toEqual(entries.slice(0, DOZO_ADMIN_RECENT_PAYMENTS));
  });

  it("never shows a partial read as a total", () => {
    const revenue = revenueOf(ledgerOf([entry(), entry({ status: "failed" })], { partial: true }));
    expect(revenue.totals).toBeNull();
    expect(revenue.failed).toBeNull();
    expect(revenue.recent).toHaveLength(2);
  });
});

function setup(ledger?: DozoPaymentLedger) {
  const people = [
    { id: "admin", email: "owner@example.test", emailVerified: true },
    { id: "ada", email: "ada@example.test", emailVerified: true },
  ];
  const accounts = [
    { customerId: "cus_ada", subscriptionId: "sub_ada", ...billing("org-ada") },
    { customerId: "cus_team", subscriptionId: null, ...billing("org-team", { byokTier: "max" }) },
  ];
  const prisma = {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          people.find((row) => row.id === where.id) ?? null,
      ),
      count: vi.fn(async () => 3),
    },
    billingAccount: {
      findMany: vi.fn(async () => accounts),
      groupBy: vi.fn(async () => [{ status: "active", _count: { _all: 2 } }]),
    },
    dozoPlanGrant: { findMany: vi.fn(async () => []) },
    member: {
      findMany: vi.fn(async ({ distinct }: { distinct?: string[] }) =>
        distinct
          ? [{ userId: "ada" }, { userId: "admin" }]
          : [
              {
                userId: "ada",
                organizationId: "org-ada",
                role: "owner",
                user: { id: "ada", email: "ada@example.test" },
              },
              // A member who does not own the organization is never its payer or its plan.
              {
                userId: "admin",
                organizationId: "org-team",
                role: "member",
                user: { id: "admin", email: "owner@example.test" },
              },
              {
                userId: "admin",
                organizationId: "org-admin",
                role: "owner",
                user: { id: "admin", email: "owner@example.test" },
              },
            ],
      ),
    },
  };
  const deps = { prisma, env: { adminEmails: ["owner@example.test"] } } as unknown as RouterDeps;
  const routes = {
    dozoAdmin: { billing: dozoAdminBillingRoutes(createRouterContext(deps), ledger) },
  };
  const as = (userId: string) =>
    createRouterClient(routes, {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoAdmin.billing;
  return { prisma, as };
}

function reader(entries: DozoLedgerEntry[], more: Partial<DozoLedger> = {}) {
  return { read: vi.fn(async () => ledgerOf(entries, more)) };
}

describe("the billing procedures", () => {
  it("refuses anyone who is not an admin, before anything is read", async () => {
    const ledger = reader([]);
    const { as, prisma } = setup(ledger);
    const refused = { code: "FORBIDDEN" };
    await expect(as("ada").summary()).rejects.toMatchObject(refused);
    await expect(as("ada").revenue({ period: "thisMonth" })).rejects.toMatchObject(refused);
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.billingAccount.findMany).not.toHaveBeenCalled();
    expect(ledger.read).not.toHaveBeenCalled();
  });

  it("counts in the database and reads only live subscriptions and unexpired grants", async () => {
    const { as, prisma } = setup();
    const summary = await as("admin").summary();
    expect(summary).toMatchObject({ members: 3, paid: 2 });
    // Ada owns a Premium organization; the admin is in the Premium Plus team but owns another.
    expect(summary.plans.map((plan) => plan.total)).toEqual([2, 1, 0]);
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: DOZO_ADMIN_LIVE_STATUSES } } }),
    );
    expect(prisma.dozoPlanGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { endsAt: { gt: expect.any(Date) } } }),
    );
  });

  it("answers null for payments when no provider is configured", async () => {
    const { as } = setup();
    expect(await as("admin").revenue({ period: "lastMonth" })).toBeNull();
  });

  it("reads the period for the deployment's payers and subscriptions and names the owner", async () => {
    const ledger = reader(
      [
        entry({ currency: "USD" }),
        entry({ customerId: "cus_team", status: "failed" }),
        entry({ customerId: "cus_gone", status: "refunded", amount: 300 }),
      ],
      { unclassified: 1 },
    );
    const { as } = setup(ledger);
    const revenue = await as("admin").revenue({ period: "lastMonth" });
    const [range, accounts] = ledger.read.mock.calls[0] as unknown as [
      { from: Date; to: Date },
      { customers: Set<string>; subscriptions: Set<string> },
    ];
    expect(range.to.getTime() - range.from.getTime()).toBeGreaterThan(27 * day);
    expect([...accounts.customers]).toEqual(["cus_ada", "cus_team"]);
    expect([...accounts.subscriptions]).toEqual(["sub_ada"]);
    expect(revenue).toEqual({
      totals: [{ currency: "usd", paid: 1000, refunded: 300 }],
      failed: 1,
      unclassified: 1,
      payments: [
        {
          member: { id: "ada", email: "ada@example.test" },
          amount: 1000,
          currency: "usd",
          at: now.toISOString(),
          status: "paid",
        },
        { member: null, amount: 1000, currency: "usd", at: now.toISOString(), status: "failed" },
        { member: null, amount: 300, currency: "usd", at: now.toISOString(), status: "refunded" },
      ],
    });
  });

  it("reuses a read for a minute, per period, and never keeps a failed one", async () => {
    vi.useFakeTimers({ now });
    try {
      const ledger = reader([]);
      ledger.read.mockRejectedValueOnce(new Error("provider down"));
      const { as } = setup(ledger);
      const client = as("admin");
      await expect(client.revenue({ period: "thisMonth" })).rejects.toThrow();
      await client.revenue({ period: "thisMonth" });
      await client.revenue({ period: "thisMonth" });
      expect(ledger.read).toHaveBeenCalledTimes(2);
      await client.revenue({ period: "last12Months" });
      expect(ledger.read).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(DOZO_ADMIN_REVENUE_CACHE_MS + 1);
      await client.revenue({ period: "thisMonth" });
      expect(ledger.read).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
