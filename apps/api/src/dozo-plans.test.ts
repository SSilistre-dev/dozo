import type { BillingSubscriptionSnapshot, SandboxProvider } from "@rakazo/adapter-kit";
import { BillingEmulator, sandboxAllowanceUsedUp } from "@rakazo/adapters";
import type * as Contracts from "@rakazo/contracts";
import type { Actor, ByokTier } from "@rakazo/contracts";
import {
  appContract,
  BYOK_TIERS,
  byokTierPriceCents,
  DOZO_PLANS_OFFERED,
  DOZO_PLANS_ON_SALE,
  SPEECH_ALLOWANCE_PERCENT,
  sandboxAllowanceHours,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import {
  hasModelAccess,
  memberHasModelAccess,
  planComputerSize,
  speechAllowancePlan,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing/billing.js";
import { createReferrals } from "./billing/referrals.js";
import { PlanComingSoonError, PlanNotOfferedError } from "./dozo-billing.js";

// Runs on the branded tree only: the plans exist once the brand rules are applied.

/** A tier's shared-space limit, read as the server reads it: upstream's tier type has no such field. */
function sharedSpaceBytes(tier: ByokTier) {
  const terms: { name: string; sharedSpaceBytes?: number } = BYOK_TIERS[tier];
  return terms.sharedSpaceBytes;
}

type Account = {
  organizationId: string;
  customerId: string;
  status: string | null;
  subscribedAt: Date | null;
  [key: string]: unknown;
};

const store = vi.hoisted(() => ({
  account: null as Account | null,
  credits: {
    organizationId: "org-1",
    mode: null as string | null,
    balanceMicros: 0n,
    byokFreeUntil: null as Date | null,
  },
  billingOn: true,
  trialHolds: 0,
  grant: null as { tier: string; endsAt: Date } | null,
  fileBytes: 0,
  /** What an admin set on the plans page, as `dozo_plan_quotas` rows. */
  quotas: [] as { tier: string; sharedSpaceMb: number | null; computerHours: number | null }[],
}));

// The database helpers have upstream's own PostgreSQL tests; here one organization lives in memory.
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  organizationForMember: async () => ({ organizationId: "org-1", isOwner: true }),
  creditAccount: async () => store.credits,
  unexpiredCreditAccount: async () => store.credits,
  billingAccountForOrganization: async () => store.account,
  createBillingAccount: async (_prisma: unknown, input: Pick<Account, "customerId">) => {
    store.account ??= { organizationId: "org-1", status: null, subscribedAt: null, ...input };
    return store.account;
  },
  organizationOwnerHadTrial: async () => false,
  syncCreditPurchases: async () => false,
  syncBillingSnapshot: async (
    _prisma: unknown,
    _customerId: string,
    load: () => Promise<BillingSubscriptionSnapshot | null>,
  ) => {
    const snapshot = await load();
    if (!store.account) return false;
    Object.assign(store.account, {
      status: null,
      subscriptionId: null,
      byokPriceCents: null,
      byokInterval: null,
      byokTier: null,
      creditAmountCents: null,
      cancelAtPeriodEnd: false,
      currentPeriodStartsAt: null,
      currentPeriodEndsAt: null,
      ...snapshot,
    });
    if (snapshot) store.account.subscribedAt ??= new Date();
    return true;
  },
  releaseByokTrialCheckouts: async () => undefined,
  reserveByokTrialCheckout: async () => {
    store.trialHolds += 1;
    return { expiresAt: new Date() };
  },
}));
// Which paid plans are on sale: none, as `DOZO_PLANS_ON_SALE` ships. A test that needs a plan
// on sale (what selling it would do) adds its tier here.
const onSale = vi.hoisted(() => new Set<string>());
vi.mock("@rakazo/contracts", async (original) => {
  const contracts = await original<typeof Contracts>();
  return {
    ...contracts,
    planOnSale: (tier: ByokTier) => onSale.has(tier) || contracts.planOnSale(tier),
  };
});
// The lease is a row in the database; here the one organization has no other checkout to wait for.
vi.mock("./billing/checkout-lease.js", async (original) => ({
  ...(await original<typeof import("./billing/checkout-lease.js")>()),
  withCheckoutLease: async (
    _prisma: unknown,
    _organizationId: string,
    work: (underLease: <R>(write: (tx: never) => Promise<R>) => Promise<R>) => Promise<unknown>,
  ) => work((write) => write({} as never)),
}));
vi.mock("./auth/access-grants.js", () => ({ applyAccessGrants: async () => undefined }));

/** Computer hours run this period, as the usage query answers. */
const runs: { kind: string; hours: number }[] = [];

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

const prisma = {
  space: {
    findFirst: async () => null,
    findUnique: async () => ({
      organizationId: "org-1",
      organization: {
        modelCredits: store.credits,
        billing: store.account,
        dozoPlanGrant: store.grant,
      },
    }),
  },
  spaceMember: {
    findUnique: async () => ({
      member: {
        role: "owner",
        organization: { modelCredits: store.credits, billing: store.account },
      },
    }),
  },
  // The size the computer has stored is the largest, so the answer is the plan's own limit.
  computer: {
    findUnique: async () => ({
      size: "xlarge",
      space: {
        organization: {
          modelCredits: store.credits,
          billing: store.account,
          dozoPlanGrant: store.grant,
        },
      },
    }),
  },
  billingAccount: { findUnique: async () => store.account },
  dozoPlanGrant: { findUnique: async () => store.grant },
  modelCreditAccount: {
    update: async ({ data }: { data: object }) => Object.assign(store.credits, data),
    updateMany: async ({ where, data }: { where: { balanceMicros?: unknown }; data: object }) => {
      if (where.balanceMicros && store.credits.balanceMicros <= 0n) return { count: 0 };
      Object.assign(store.credits, data);
      return { count: 1 };
    },
  },
  deploymentSettings: { findUnique: async () => ({ modelCreditsEnabled: store.billingOn }) },
  organization: {
    findUnique: async () => ({
      modelCredits: store.credits,
      billing: store.account,
      dozoPlanGrant: store.grant,
    }),
  },
  accessGrant: {
    aggregate: async () => ({ _sum: { creditCents: null }, _min: { appliedAt: null } }),
  },
  computerAllowanceGrant: { aggregate: async () => ({ _sum: { amountCents: null } }) },
  referral: { findUnique: async () => null },
  dozoPlanQuota: { findMany: async () => store.quotas },
  member: { count: async () => 1 },
  // Two questions reach the database raw: the bytes of the organization's files, and its
  // computer hours.
  $queryRaw: async (query: { sql?: string }) =>
    query.sql?.includes('"artifacts"')
      ? Number.isNaN(store.fileBytes)
        ? Promise.reject(new Error("the count failed"))
        : [{ used: String(store.fileBytes) }]
      : runs,
  $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
} as unknown as PrismaClient;

/** The operator's own host, as the shipped stack runs it: the provider reports no metering. */
// The operator's own host: the provider every hosted computer here starts on.
const sandbox = { describe: () => ({ id: "docker" }) } as SandboxProvider;
const hostedComputer = { spaceId: "space-1", kind: "docker" };

function setup() {
  const provider = new BillingEmulator({ modelCredits: true });
  const billing = createBillingService({
    prisma,
    provider,
    sandbox,
    managedModelsAvailable: false,
    webOrigin: "https://app.example.test",
  });
  return { provider, billing };
}

/**
 * A subscription bought before the plan stopped being sold, at the price it had then: opened with
 * the payment provider directly, since the server sells neither plan now.
 */
async function subscribedEarlier(
  { provider, billing }: ReturnType<typeof setup>,
  tier: "pro" | "max",
  amountCents = BYOK_TIERS[tier].monthlyPriceCents ?? 0,
) {
  const { customerId } = await provider.createCustomer({
    email: actor.email,
    organizationId: "org-1",
  });
  store.account = { organizationId: "org-1", customerId, status: null, subscribedAt: null };
  await provider.createByokCheckout({
    customerId,
    amountCents,
    interval: "month",
    tier,
    successUrl: "https://app.example.test/app",
    cancelUrl: "https://app.example.test/app",
  });
  provider.completeByokCheckout(customerId);
  await billing.syncForActor(actor);
}

describe("plans that are not on sale", () => {
  it("offers Premium alone and sells no paid plan yet", () => {
    expect(DOZO_PLANS_OFFERED).toEqual(["pro"]);
    expect(DOZO_PLANS_ON_SALE).toEqual([]);
  });

  it("refuses Free a checkout of Premium or Premium Plus and opens nothing", async () => {
    const { billing, provider } = setup();
    for (const tier of ["pro", "max"] as const) {
      for (const interval of ["month", "year"] as const) {
        const refusal = await billing
          .checkout(actor, undefined, interval, tier)
          .catch((error) => error);
        expect(refusal).toBeInstanceOf(PlanComingSoonError);
        expect(refusal).toBeInstanceOf(ClientError);
        expect(refusal).toMatchObject({ kind: "BAD_REQUEST", code: "plan_coming_soon" });
      }
    }
    expect(store.account).toBeNull();
    expect(provider.byokCheckouts.size).toBe(0);
  });

  it("opens no checkout when Free picks its own key and names a paid plan", async () => {
    const { billing, provider } = setup();
    for (const tier of ["pro", "max"] as const) {
      const chosen = await billing.selectFunding(actor, "byok", undefined, "year", tier);
      expect(chosen).toEqual({ ok: true });
    }
    expect(provider.byokCheckouts.size).toBe(0);
    expect(provider.subscriptions).toHaveLength(0);
  });

  it("shows Free the price of Premium as coming soon, and no Premium Plus", async () => {
    const { byokTiers } = await setup().billing.status(actor);
    expect(byokTiers).toEqual([
      expect.objectContaining({
        tier: "pro",
        name: "Premium",
        monthlyPriceCents: BYOK_TIERS.pro.monthlyPriceCents,
        comingSoon: true,
      }),
    ]);
  });

  it("drops the coming soon mark once a plan is on sale", async () => {
    onSale.add("pro");
    const { byokTiers } = await setup().billing.status(actor);
    expect(byokTiers?.[0]).not.toHaveProperty("comingSoon");
  });

  it("refuses an earlier subscriber a move to a plan that is not sold, and bills nothing", async () => {
    const plus = setup();
    await subscribedEarlier(plus, "max");
    const toPremium = await plus.billing.changeTier(actor, "pro").catch((error) => error);
    expect(toPremium).toBeInstanceOf(PlanComingSoonError);
    expect(toPremium).toMatchObject({ code: "plan_coming_soon" });
    expect(plus.provider.subscriptions[0]).toMatchObject({
      byokTier: "max",
      byokPriceCents: BYOK_TIERS.max.monthlyPriceCents,
    });

    store.account = null;
    const premium = setup();
    await subscribedEarlier(premium, "pro");
    await expect(premium.billing.changeTier(actor, "max")).rejects.toMatchObject({
      code: "plan_coming_soon",
    });
    expect(premium.provider.subscriptions[0]).toMatchObject({ byokTier: "pro" });
  });

  it("refuses an earlier monthly subscriber the switch to yearly", async () => {
    const premium = setup();
    await subscribedEarlier(premium, "pro");
    const refusal = await premium.billing.switchToYearly(actor).catch((error) => error);
    expect(refusal).toBeInstanceOf(PlanComingSoonError);
    expect(premium.provider.subscriptions[0]).toMatchObject({ byokInterval: "month" });

    store.account = null;
    const plus = setup();
    await subscribedEarlier(plus, "max");
    await expect(plus.billing.switchToYearly(actor)).rejects.toMatchObject({
      code: "plan_coming_soon",
    });
    expect(plus.provider.subscriptions[0]).toMatchObject({ byokInterval: "month" });
  });

  it("keeps an earlier Premium Plus subscriber's plan, price, hours and size through a sync", async () => {
    const context = setup();
    await subscribedEarlier(context, "max");
    await context.billing.syncForActor(actor);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      state: "active",
      byokTier: "max",
      byokPriceCents: BYOK_TIERS.max.monthlyPriceCents,
      computerHoursLeft: sandboxAllowanceHours(BYOK_TIERS.max.computerAllowanceCents),
      sharedSpace: { plan: "Premium Plus", limitBytes: sharedSpaceBytes("max") },
    });
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe("xlarge");
  });
});

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  store.account = null;
  store.credits = { organizationId: "org-1", mode: null, balanceMicros: 0n, byokFreeUntil: null };
  store.billingOn = true;
  store.trialHolds = 0;
  store.grant = null;
  store.fileBytes = 0;
  store.quotas = [];
  runs.length = 0;
  onSale.clear();
});

describe("Dozo plans", () => {
  it("names the tiers and keeps their ids", () => {
    expect(Object.keys(BYOK_TIERS)).toEqual(["standard", "pro", "max"]);
    expect(Object.values(BYOK_TIERS).map((terms) => terms.name)).toEqual([
      "Free",
      "Premium",
      "Premium Plus",
    ]);
  });

  it("has no fourth tier: checkout, funding and plan change refuse upstream's Ultra", () => {
    const { checkout, selectFunding, changeTier } = appContract.billing;
    const accepts = (procedure: { "~orpc": { inputSchema?: unknown } }, input: unknown) =>
      (
        procedure["~orpc"].inputSchema as { safeParse: (value: unknown) => { success: boolean } }
      ).safeParse(input).success;
    const named = { tier: "ultra", client: "web" };
    expect(accepts(checkout, named)).toBe(false);
    expect(accepts(selectFunding, { funding: "byok", ...named })).toBe(false);
    expect(accepts(changeTier, named)).toBe(false);
    expect(accepts(changeTier, { tier: "max" })).toBe(true);
  });

  it("makes Free cost nothing and include no hosted computer", () => {
    expect(BYOK_TIERS.standard).toMatchObject({
      monthlyPriceCents: null,
      annualPriceCents: null,
      computerAllowanceCents: 0,
    });
    expect(byokTierPriceCents("standard", "month")).toBeNull();
  });

  it("keeps both paid plans' prices and computer allowances, though neither is sold", () => {
    for (const tier of ["pro", "max"] as const) {
      expect(byokTierPriceCents(tier, "month")).toBe(BYOK_TIERS[tier].monthlyPriceCents);
      expect(byokTierPriceCents(tier, "month")).toBeGreaterThan(0);
      expect(BYOK_TIERS[tier].computerAllowanceCents).toBeGreaterThan(0);
    }
    expect(BYOK_TIERS.max.computerAllowanceCents).toBeGreaterThan(
      BYOK_TIERS.pro.computerAllowanceCents,
    );
  });
});

describe("an organization on Free", () => {
  it("starts with access, no trial, no end date and nothing to pay", async () => {
    const { billing } = setup();
    const status = await billing.status(actor);
    expect(status).toMatchObject({
      access: true,
      funding: "byok",
      state: "none",
      byokPriceCents: null,
      byokFreeUntil: null,
      trialAvailable: false,
      hasCustomer: false,
      computerHoursLeft: 0,
    });
    expect(store.account).toBeNull();
  });

  it("is shown Premium, not Premium Plus or Free, with its hours", async () => {
    const { billing } = setup();
    const { byokTiers } = await billing.status(actor);
    expect(byokTiers?.map((offer) => [offer.tier, offer.name])).toEqual([["pro", "Premium"]]);
    expect(byokTiers?.[0]?.computerHours).toBe(
      sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents),
    );
  });

  it("may run bots on its own model connection", async () => {
    expect(hasModelAccess(store.credits, null)).toBe(true);
    expect(hasModelAccess({ ...store.credits, mode: "byok" }, null)).toBe(true);
    await expect(memberHasModelAccess(prisma, actor)).resolves.toBe(true);
  });

  it("is refused a hosted computer by the server", async () => {
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(true);
  });

  it("keeps a computer on its own machine, which costs nothing", async () => {
    await expect(
      sandboxAllowanceUsedUp({ prisma, sandbox }, { spaceId: "space-1", kind: "desktop" }),
    ).resolves.toBe(false);
  });

  it("cannot check out Free, named or by naming no plan, and is told why", async () => {
    const { billing, provider } = setup();
    for (const tier of ["standard", undefined] as const) {
      const refusal = await billing
        .checkout(actor, undefined, "month", tier)
        .catch((error) => error);
      expect(refusal).toBeInstanceOf(PlanNotOfferedError);
      expect(refusal).toBeInstanceOf(ClientError);
      expect(refusal).toMatchObject({ kind: "BAD_REQUEST", code: "plan_not_offered" });
    }
    // Nothing was opened with the payment provider.
    expect(store.account).toBeNull();
    expect(provider.byokCheckouts.size).toBe(0);
  });

  it("sees its plan's name and how much of its shared space is used", async () => {
    store.fileBytes = 120 * 1024 * 1024;
    const { billing } = setup();
    await expect(billing.status(actor)).resolves.toMatchObject({
      sharedSpace: {
        plan: "Free",
        usedBytes: 120 * 1024 * 1024,
        limitBytes: 500 * 1024 ** 2,
      },
    });
  });

  it("has no referral reward, which was a free month of the first tier", () => {
    const { provider } = setup();
    expect(
      createReferrals({ prisma, provider, webOrigin: "https://app.example.test" }).enabled,
    ).toBe(false);
  });
});

describe("a Premium subscriber", () => {
  it("once Premium is on sale, pays its price from the first day, without a trial", async () => {
    onSale.add("pro");
    const context = setup();
    await context.billing.checkout(actor, undefined, "month", "pro");
    const checkout = context.provider.byokCheckouts.get(store.account!.customerId);
    context.provider.completeByokCheckout(store.account!.customerId);
    await context.billing.syncForActor(actor);
    expect(checkout).toMatchObject({
      tier: "pro",
      interval: "month",
      amountCents: BYOK_TIERS.pro.monthlyPriceCents,
    });
    expect(checkout).not.toHaveProperty("trialDays");
    expect(store.trialHolds).toBe(0);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "byok",
      state: "active",
      byokTier: "pro",
      byokPriceCents: BYOK_TIERS.pro.monthlyPriceCents,
      trialAvailable: false,
    });
  });

  it("sees its own plan's name and shared space", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    store.fileBytes = 1024 ** 3;
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      sharedSpace: {
        plan: "Premium",
        usedBytes: 1024 ** 3,
        limitBytes: 2 * 1024 ** 3,
      },
    });
  });

  it("is not ended because Free exists", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    await context.billing.syncForActor(actor);
    expect(context.provider.subscriptions).toHaveLength(1);
    expect(context.provider.subscriptions[0]).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });

  it("uses up its hours on the operator's own host too", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    const hours = sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents);
    runs.push({ kind: "docker", hours: hours - 1 });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
    await expect(context.billing.status(actor)).resolves.toMatchObject({ computerHoursLeft: 1 });
    runs.push({ kind: "docker", hours: 1 });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(true);
  });

  it("gets the plan's computer hours and size", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    const status = await context.billing.status(actor);
    expect(status.computerHoursLeft).toBe(
      sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents),
    );
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe(BYOK_TIERS.pro.computerSize);
  });

  it("is shown the vCPUs and memory the host starts each plan's computer with", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    const context = setup();
    await subscribedEarlier(context, "pro");
    const status = await context.billing.status(actor);
    expect(status.byokTiers?.map((offer) => [offer.name, offer.computerSpec])).toEqual([
      ["Premium", { vcpus: 2, memoryGb: 2 }],
    ]);
  });

  it("starts its computer at the size of the plan it is on now", async () => {
    const premium = setup();
    await subscribedEarlier(premium, "pro");
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe("large");
    store.account = null;
    await subscribedEarlier(setup(), "max");
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe("xlarge");
  });

  it("moves up only to a plan on sale, and never to Free, which is cancelling", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    // Premium Plus is not offered, even while Premium is on sale.
    onSale.add("pro");
    await expect(context.billing.changeTier(actor, "max")).rejects.toMatchObject({
      code: "plan_coming_soon",
    });
    await expect(context.billing.changeTier(actor, "standard")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(context.billing.status(actor)).resolves.toMatchObject({ byokTier: "pro" });
  });

  it("moves down only when this month's use fits the hours an admin set for the smaller plan", async () => {
    onSale.add("pro");
    const context = setup();
    await subscribedEarlier(context, "max");
    runs.push({ kind: "docker", hours: 50 });
    // Premium's hours lowered below what was used: refused, whatever the plan's terms say.
    store.quotas = [{ tier: "pro", sharedSpaceMb: null, computerHours: 10 }];
    expect(sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents)).toBeGreaterThan(50);
    await expect(context.billing.changeTier(actor, "pro")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // Premium's hours raised above Premium Plus's: not a smaller plan, so no use to fit.
    runs.length = 0;
    runs.push({ kind: "docker", hours: 250 });
    store.quotas = [{ tier: "pro", sharedSpaceMb: null, computerHours: 300 }];
    expect(sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents)).toBeLessThan(250);
    await context.billing.changeTier(actor, "pro");
    await expect(context.billing.status(actor)).resolves.toMatchObject({ byokTier: "pro" });
  });

  it("falls back to Free when the subscription ends: bots run, the computer does not", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    await context.provider.cancelCustomerSubscriptions(store.account!.customerId);
    await context.billing.syncForActor(actor);
    const status = await context.billing.status(actor);
    expect(status).toMatchObject({
      access: true,
      funding: "byok",
      state: "canceled",
      computerHoursLeft: 0,
    });
    expect(hasModelAccess(store.credits, store.account!.status)).toBe(true);
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(true);
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe("standard");
  });
});

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
/** A plan an admin granted that ends `days` from now (before now when negative). */
const grant = (tier: string, days: number) => ({ tier, endsAt: new Date(Date.now() + days * DAY) });

describe("a plan an admin granted", () => {
  it("gives an organization on Free the plan's computer, hours and tier, and no price", async () => {
    store.grant = grant("pro", 30);
    const { billing } = setup();
    const status = await billing.status(actor);
    expect(status).toMatchObject({
      byokTier: "pro",
      byokPriceCents: null,
      byokAnnualPriceCents: null,
      byokFreeUntil: null,
      state: "none",
      hasCustomer: false,
      computerHoursLeft: sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents),
    });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe(BYOK_TIERS.pro.computerSize);
  });

  it("is Free again once it has ended: no computer, the first tier's size", async () => {
    store.grant = grant("max", -1);
    const status = await setup().billing.status(actor);
    expect(status).toMatchObject({ byokTier: "standard", computerHoursLeft: 0 });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(true);
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe("standard");
  });

  it("names the granted plan and its shared space in the status, and Free's once it ended", async () => {
    store.fileBytes = GB;
    store.grant = grant("pro", 30);
    const { billing } = setup();
    await expect(billing.status(actor)).resolves.toMatchObject({
      sharedSpace: { plan: "Premium", usedBytes: GB, limitBytes: sharedSpaceBytes("pro") },
    });
    store.grant = grant("max", 30);
    await expect(billing.status(actor)).resolves.toMatchObject({
      sharedSpace: {
        plan: "Premium Plus",
        usedBytes: GB,
        limitBytes: sharedSpaceBytes("max"),
      },
    });
    store.grant = grant("max", -1);
    await expect(billing.status(actor)).resolves.toMatchObject({
      sharedSpace: {
        plan: "Free",
        usedBytes: GB,
        limitBytes: sharedSpaceBytes("standard"),
      },
    });
  });

  it("does not count a tier an admin cannot grant", async () => {
    store.grant = grant("standard", 30);
    await expect(setup().billing.status(actor)).resolves.toMatchObject({ byokTier: "standard" });
    store.grant = grant("gold", 30);
    await expect(setup().billing.status(actor)).resolves.toMatchObject({ byokTier: "standard" });
  });

  it("raises a lower subscription and leaves a higher one alone", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    store.grant = grant("max", 30);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      // The subscription's own price: the grant has none.
      byokPriceCents: BYOK_TIERS.pro.monthlyPriceCents,
      computerHoursLeft: sandboxAllowanceHours(BYOK_TIERS.max.computerAllowanceCents),
    });
    await expect(planComputerSize(prisma, "computer-1")).resolves.toBe(BYOK_TIERS.max.computerSize);
    store.account = null;
    await subscribedEarlier(setup(), "max");
    store.grant = grant("pro", 30);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      byokPriceCents: BYOK_TIERS.max.monthlyPriceCents,
    });
  });
});

describe("an admin's free access to a paid plan", () => {
  it("still gives speech from the plan's price, Premium Plus included, though neither is sold", async () => {
    for (const tier of ["pro", "max"] as const) {
      const price = BYOK_TIERS[tier].monthlyPriceCents ?? 0;
      expect(price, `${tier} keeps a price`).toBeGreaterThan(0);
      Object.assign(store.credits, {
        mode: "byok",
        freeByokTiers: [{ tier, expiresAt: new Date(Date.now() + 30 * DAY) }],
      });
      const plan = await speechAllowancePlan(prisma, "org-1");
      expect(plan?.limitMicros, tier).toBe(BigInt(price) * BigInt(SPEECH_ALLOWANCE_PERCENT) * 100n);
    }
  });
});

describe("a server that sells seats, without model credits", () => {
  it("still holds an unsubscribed organization behind its paywall", async () => {
    const provider = new BillingEmulator();
    const billing = createBillingService({
      prisma,
      provider,
      webOrigin: "https://app.example.test",
    });
    const status = await billing.status(actor);
    expect(billing.modelCreditsEnabled).toBe(false);
    expect(status).toMatchObject({ access: false, state: "none", trialAvailable: true });
    expect(status).not.toHaveProperty("funding");
    expect(status).not.toHaveProperty("byokTiers");
  });
});

describe("a billing status whose count of files fails", () => {
  it("still answers, without the shared space", async () => {
    store.fileBytes = Number.NaN;
    const status = await setup().billing.status(actor);
    expect(status).toMatchObject({ access: true, funding: "byok" });
    expect(status.sharedSpace).toBeUndefined();
  });
});

describe("a server that does not bill", () => {
  it("shows no shared space, which has no limit there", async () => {
    store.billingOn = false;
    store.fileBytes = 50 * 1024 ** 3;
    const status = await setup().billing.status(actor);
    expect(status.sharedSpace).toBeUndefined();
  });

  it("never limits computers, whatever the plans say", async () => {
    store.billingOn = false;
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
  });
});

describe("the end of the plan in force, in the status", () => {
  it("has none on Free", async () => {
    const status = await setup().billing.status(actor);
    expect(status.planEnd).toBeUndefined();
  });

  it("renews a subscription at the end of its period", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    const periodEnd = store.account!.currentPeriodEndsAt as Date;
    expect(periodEnd).toBeInstanceOf(Date);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      planEnd: { at: periodEnd.toISOString(), renews: true },
    });
  });

  it("tells a member when a granted plan ends, and nothing once it has", async () => {
    store.grant = grant("max", 5);
    await expect(setup().billing.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      planEnd: { at: store.grant.endsAt.toISOString(), renews: false },
    });
    store.grant = grant("max", -1);
    const ended = await setup().billing.status(actor);
    expect(ended).toMatchObject({ byokTier: "standard", computerHoursLeft: 0 });
    expect(ended.planEnd).toBeUndefined();
  });

  it("ends a grant above the subscription and names the plan that follows", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    store.grant = grant("max", 5);
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      planEnd: {
        at: store.grant.endsAt.toISOString(),
        renews: false,
        fallsTo: { from: "Premium Plus", to: "Premium" },
      },
    });
  });

  it("has none once the subscription's period is past and no webhook moved it", async () => {
    const context = setup();
    await subscribedEarlier(context, "pro");
    store.account!.currentPeriodEndsAt = new Date(Date.now() - DAY);
    const status = await context.billing.status(actor);
    expect(status.planEnd).toBeUndefined();
  });
});
