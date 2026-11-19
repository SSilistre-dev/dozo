import { createRouterClient } from "@orpc/server";
import type { DozoPaymentLedger } from "@rakazo/adapters";
import { BYOK_TIERS, sandboxAllowanceHours } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { dozoAdminBillingRoutes } from "./dozo-admin-billing.js";
import { dozoAdminPlansRoutes } from "./dozo-admin-plans.js";
import { withPlanHours } from "./dozo-billing.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// Runs on the branded tree only: Free, Premium and Premium Plus exist once the rules are applied.

type QuotaRow = { tier: string; sharedSpaceMb: number | null; computerHours: number | null };

/**
 * Two members: Ada owns a Premium organization, the admin owns a Free one. The quota rows and the
 * audit events are kept as the SQL the quota module sends would keep them.
 */
function setup(quotas: QuotaRow[] = [], ledger?: DozoPaymentLedger) {
  let rows = quotas.map((row) => ({ ...row }));
  const events: Record<string, unknown>[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "admin"
          ? { id: "admin", email: "owner@example.test", emailVerified: true }
          : { id: where.id, email: `${where.id}@example.test`, emailVerified: true },
      ),
      count: vi.fn(async () => 2),
    },
    billingAccount: {
      findMany: vi.fn(async () => [
        {
          organizationId: "org-ada",
          status: "active",
          byokTier: "pro",
          byokInterval: "month",
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          cancelAtPeriodEnd: false,
        },
      ]),
      groupBy: vi.fn(async () => [{ status: "active", _count: { _all: 1 } }]),
    },
    dozoPlanGrant: { findMany: vi.fn(async () => []) },
    member: {
      findMany: vi.fn(async ({ distinct }: { distinct?: string[] }) =>
        distinct
          ? [{ userId: "ada" }]
          : [{ userId: "ada", organizationId: "org-ada", role: "owner" }],
      ),
    },
    dozoPlanQuota: { findMany: vi.fn(async () => rows.map((row) => ({ ...row }))) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, tier: string) =>
      sql(strings).includes("FOR UPDATE") ? rows.filter((row) => row.tier === tier) : [],
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("INSERT")) {
        const [tier] = values as [string];
        if (!rows.some((row) => row.tier === tier))
          rows.push({ tier, sharedSpaceMb: null, computerHours: null });
      } else if (text.includes("UPDATE")) {
        const [sharedSpaceMb, computerHours, , tier] = values as [
          number | null,
          number | null,
          string,
          string,
        ];
        rows = rows.map((row) =>
          row.tier === tier ? { tier, sharedSpaceMb, computerHours } : row,
        );
      }
      return 1;
    }),
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  const deps = { prisma, env: { adminEmails: ["owner@example.test"] } } as unknown as RouterDeps;
  const ctx = createRouterContext(deps);
  const routes = {
    dozoAdmin: {
      plans: dozoAdminPlansRoutes(ctx, ledger),
      billing: dozoAdminBillingRoutes(ctx, undefined),
    },
  };
  const as = (userId: string) =>
    createRouterClient(routes, {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoAdmin;
  return { prisma, as, events, rows: () => rows };
}

describe("the plans procedures", () => {
  it("refuse anyone who is not an admin, before anything is read or written", async () => {
    const { as, prisma } = setup();
    const refused = { code: "FORBIDDEN" };
    await expect(as("ada").plans.list()).rejects.toMatchObject(refused);
    await expect(as("ada").plans.setQuota({ tier: "pro", sharedSpaceMb: 1 })).rejects.toMatchObject(
      refused,
    );
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("count each plan's members exactly as the billing summary does", async () => {
    const { as } = setup();
    const [{ plans }, summary] = await Promise.all([
      as("admin").plans.list(),
      as("admin").billing.summary(),
    ]);
    expect(plans.map((plan) => [plan.tier, plan.members])).toEqual(
      summary.plans.map((count) => [count.tier, count.total]),
    );
    expect(plans.map((plan) => plan.members)).toEqual([1, 1, 0]);
  });

  it("show prices and terms from code, the machine, and a provider's price keys", async () => {
    const ledger = {
      read: vi.fn(),
      priceKey: vi.fn(
        ({
          tier,
          interval,
          amountCents,
        }: {
          tier: string;
          interval: string;
          amountCents: number;
        }) => `${tier}-${interval}-${amountCents}`,
      ),
    };
    const { plans } = await setup([], ledger).as("admin").plans.list();
    const [free, premium] = plans;
    expect(free).toMatchObject({
      name: "Free",
      monthlyPriceCents: null,
      priceKeys: { month: null, year: null },
      computer: null,
      computerHoursEditable: false,
      sharedSpaceMb: { value: 500, terms: 500, set: false },
    });
    expect(premium).toMatchObject({
      name: BYOK_TIERS.pro.name,
      monthlyPriceCents: BYOK_TIERS.pro.monthlyPriceCents,
      annualPriceCents: BYOK_TIERS.pro.annualPriceCents,
      currency: "usd",
      priceKeys: {
        month: `pro-month-${BYOK_TIERS.pro.monthlyPriceCents}`,
        year: `pro-year-${BYOK_TIERS.pro.annualPriceCents}`,
      },
      computerHoursEditable: true,
    });
    expect(premium?.computer).toEqual({
      vcpus: expect.any(Number),
      memoryGb: expect.any(Number),
    });
    // Without a payment provider there is no key to show.
    const bare = await setup().as("admin").plans.list();
    expect(bare.plans[1]?.priceKeys).toEqual({ month: null, year: null });
  });

  it("show an admin's quota over the plan's terms, and the terms beside it", async () => {
    const { plans } = await setup([{ tier: "pro", sharedSpaceMb: 3000, computerHours: null }])
      .as("admin")
      .plans.list();
    expect(plans[1]?.sharedSpaceMb).toEqual({ value: 3000, terms: 2048, set: true });
    const hours = sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents);
    expect(plans[1]?.computerHours).toEqual({ value: hours, terms: hours, set: false });
  });

  it("save a quota, audit it, and answer the plans as they now hold", async () => {
    const { as, events, rows } = setup();
    const { plans } = await as("admin").plans.setQuota({ tier: "max", computerHours: 12 });
    expect(plans[2]?.computerHours).toMatchObject({ value: 12, set: true });
    expect(rows()).toEqual([{ tier: "max", sharedSpaceMb: null, computerHours: 12 }]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "deployment.settings.changed",
        userId: "admin",
        metadata: expect.objectContaining({ setting: "plan_quota", tier: "max", to: 12 }),
      }),
    ]);
    // Null returns it to the plan's terms.
    const cleared = await as("admin").plans.setQuota({ tier: "max", computerHours: null });
    expect(cleared.plans[2]?.computerHours.set).toBe(false);
  });

  it("refuse computer hours on Free, which has no computer, and save nothing", async () => {
    const { as, prisma } = setup();
    await expect(
      as("admin").plans.setQuota({ tier: "standard", computerHours: 5 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(
      as("admin").plans.setQuota({ tier: "standard", sharedSpaceMb: 100 }),
    ).resolves.toBeTruthy();
  });

  it("refuse a quota out of bounds", async () => {
    const { as } = setup();
    await expect(
      as("admin").plans.setQuota({ tier: "pro", sharedSpaceMb: -1 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      as("admin").plans.setQuota({ tier: "pro", computerHours: 1.5 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("the plans members are offered", () => {
  it("carry the computer hours an admin set, as the allowance counts them", async () => {
    const offers = [
      { tier: "pro" as const, computerHours: 100, name: "Premium" },
      { tier: "max" as const, computerHours: 200, name: "Premium Plus" },
    ];
    const prisma = {
      dozoPlanQuota: {
        findMany: async () => [{ tier: "pro", sharedSpaceMb: null, computerHours: 30 }],
      },
    };
    const hours = sandboxAllowanceHours(BYOK_TIERS.max.computerAllowanceCents);
    expect(await withPlanHours(prisma, offers)).toEqual([
      { tier: "pro", computerHours: 30, name: "Premium" },
      { tier: "max", computerHours: hours, name: "Premium Plus" },
    ]);
  });
});
