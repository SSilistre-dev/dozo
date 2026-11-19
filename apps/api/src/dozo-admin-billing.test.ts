import { createRouterClient } from "@orpc/server";
import type { DozoLedgerEntry, DozoPaymentLedger } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import type { BillingRow } from "./dozo-admin-billing.js";
import {
  billingSummary,
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

describe("counting plans", () => {
  it("counts each paid tier by how it is billed, grants apart, and everyone else as Free", () => {
    const summary = billingSummary(
      10,
      [
        billing("monthly-pro"),
        billing("yearly-pro", { byokInterval: "year" }),
        billing("yearly-max", { byokTier: "max", byokInterval: "year" }),
        // A Premium subscription under a granted Premium Plus counts as the grant.
        billing("raised", { byokTier: "pro" }),
        // Ended: on Free.
        billing("ended", { status: "canceled" }),
        // Credits only: paid, but no own-model tier.
        billing("credits", { byokTier: null }),
      ],
      [
        { organizationId: "raised", tier: "max", endsAt: inDays(60) },
        { organizationId: "gift", tier: "pro", endsAt: inDays(90) },
        // Expired grants count as none.
        { organizationId: "old", tier: "max", endsAt: inDays(-1) },
      ],
      now,
    );
    expect(summary.members).toBe(10);
    expect(summary.paid).toBe(5);
    expect(summary.granted).toBe(2);
    expect(summary.plans).toEqual([
      { tier: "standard", total: 5, monthly: 0, yearly: 0, granted: 0 },
      { tier: "pro", total: 3, monthly: 1, yearly: 1, granted: 1 },
      { tier: "max", total: 2, monthly: 0, yearly: 1, granted: 1 },
    ]);
  });

  it("counts trials, payment trouble, cancellations and what ends soon, once per organization", () => {
    const summary = billingSummary(
      4,
      [
        billing("trial", { status: "trialing", trialEndsAt: inDays(3) }),
        billing("late", { status: "past_due" }),
        billing("unpaid", { status: "unpaid", byokTier: "max" }),
        billing("leaving", { cancelAtPeriodEnd: true, currentPeriodEndsAt: inDays(10) }),
        // A cancelled subscription that already ended is not "cancelling".
        billing("gone", { status: "canceled", cancelAtPeriodEnd: true }),
        // Ends in 2 days by trial and in 40 by grant: counted once, by the soonest.
        billing("both", { status: "trialing", trialEndsAt: inDays(2) }),
      ],
      [
        { organizationId: "both", tier: "max", endsAt: inDays(40) },
        { organizationId: "later", tier: "pro", endsAt: inDays(45) },
      ],
      now,
    );
    expect(summary.trialing).toBe(2);
    expect(summary.pastDue).toBe(2);
    expect(summary.cancelling).toBe(1);
    expect(summary.ending).toEqual({ within7Days: 2, within30Days: 3 });
    // More organizations on a paid plan than members counted: Free never goes below zero.
    expect(summary.plans[0]).toMatchObject({ tier: "standard", total: 0 });
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

describe("summing payments", () => {
  it("totals each currency apart, counts failures and keeps the newest payments", () => {
    const entries = [
      entry(),
      entry({ amount: 500, status: "refunded" }),
      entry({ currency: "EUR", amount: 900 }),
      entry({ status: "failed" }),
      ...Array.from({ length: DOZO_ADMIN_RECENT_PAYMENTS }, () => entry({ amount: 1 })),
    ];
    const revenue = revenueOf(entries);
    expect(revenue.totals).toEqual([
      { currency: "usd", paid: 1000 + DOZO_ADMIN_RECENT_PAYMENTS, refunded: 500 },
      { currency: "eur", paid: 900, refunded: 0 },
    ]);
    expect(revenue.failed).toBe(1);
    expect(revenue.recent).toEqual(entries.slice(0, DOZO_ADMIN_RECENT_PAYMENTS));
  });
});

function setup(ledger?: DozoPaymentLedger) {
  const people = [
    { id: "admin", email: "owner@example.test", emailVerified: true },
    { id: "ada", email: "ada@example.test", emailVerified: true },
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
      findMany: vi.fn(async () => [
        { customerId: "cus_ada", ...billing("org-ada") },
        { customerId: "cus_team", ...billing("org-team", { byokTier: "max" }) },
      ]),
    },
    dozoPlanGrant: { findMany: vi.fn(async () => []) },
    member: {
      findMany: vi.fn(async () => [
        {
          organizationId: "org-ada",
          role: "owner",
          user: { id: "ada", email: "ada@example.test" },
        },
        // A member who does not own the organization is never shown as the payer.
        {
          organizationId: "org-team",
          role: "member",
          user: { id: "admin", email: "owner@example.test" },
        },
      ]),
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

function ledgerOf(entries: DozoLedgerEntry[]) {
  return { read: vi.fn(async () => ({ entries, partial: true })) };
}

describe("the billing procedures", () => {
  it("refuses anyone who is not an admin, before anything is read", async () => {
    const ledger = ledgerOf([]);
    const { as, prisma } = setup(ledger);
    const refused = { code: "FORBIDDEN" };
    await expect(as("ada").summary()).rejects.toMatchObject(refused);
    await expect(as("ada").revenue({ period: "thisMonth" })).rejects.toMatchObject(refused);
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.billingAccount.findMany).not.toHaveBeenCalled();
    expect(ledger.read).not.toHaveBeenCalled();
  });

  it("counts plans from the deployment's own records", async () => {
    const { as, prisma } = setup();
    const summary = await as("admin").summary();
    expect(summary).toMatchObject({ members: 3, paid: 2 });
    expect(summary.plans.map((plan) => plan.total)).toEqual([1, 1, 1]);
    expect(prisma.dozoPlanGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { endsAt: { gt: expect.any(Date) } } }),
    );
  });

  it("answers null for payments when no provider is configured", async () => {
    const { as } = setup();
    expect(await as("admin").revenue({ period: "lastMonth" })).toBeNull();
  });

  it("reads the period's payments for the deployment's own payers and names the owner", async () => {
    const ledger = ledgerOf([
      entry({ currency: "USD" }),
      entry({ customerId: "cus_team", status: "failed" }),
      entry({ customerId: null, status: "refunded", amount: 300 }),
    ]);
    const { as } = setup(ledger);
    const revenue = await as("admin").revenue({ period: "lastMonth" });
    const [range, customers] = ledger.read.mock.calls[0] as unknown as [
      { from: Date; to: Date },
      Set<string>,
    ];
    expect(range.to.getTime() - range.from.getTime()).toBeGreaterThan(27 * day);
    expect([...customers]).toEqual(["cus_ada", "cus_team"]);
    expect(revenue).toEqual({
      totals: [{ currency: "usd", paid: 1000, refunded: 300 }],
      failed: 1,
      partial: true,
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
      const ledger = ledgerOf([]);
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
