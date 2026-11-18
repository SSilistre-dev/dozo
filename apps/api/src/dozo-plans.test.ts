import type { BillingSubscriptionSnapshot, SandboxProvider } from "@rakazo/adapter-kit";
import { BillingEmulator, sandboxAllowanceUsedUp } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BYOK_TIERS, byokTierPriceCents, sandboxAllowanceHours } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { hasModelAccess, memberHasModelAccess, planComputerSize } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";
import { PlanNotOfferedError } from "./dozo-billing.js";
import { createReferrals } from "./referrals.js";

// Runs on the branded tree only: the plans exist once the brand rules are applied.

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
  fileBytes: 0,
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
  claimCheckoutLease: async () => "lease-1",
  checkoutLeaseHeld: async () => true,
  lockCheckoutLease: async () => true,
  renewCheckoutLease: async () => undefined,
  releaseCheckoutLease: async () => undefined,
  releaseByokTrialCheckouts: async () => undefined,
  reserveByokTrialCheckout: async () => {
    store.trialHolds += 1;
    return { expiresAt: new Date() };
  },
}));
vi.mock("./access-grants.js", () => ({ applyAccessGrants: async () => undefined }));

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
      organization: { modelCredits: store.credits, billing: store.account },
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
  billingAccount: { findUnique: async () => store.account },
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
    findUnique: async () => ({ modelCredits: store.credits, billing: store.account }),
  },
  accessGrant: {
    aggregate: async () => ({ _sum: { creditCents: null }, _min: { appliedAt: null } }),
  },
  referral: { findUnique: async () => null },
  member: { count: async () => 1 },
  // Two questions reach the database raw: the bytes of the organization's files, and its
  // computer hours.
  $queryRaw: async (query: { sql?: string }) =>
    query.sql?.includes('"artifacts"') ? [{ used: String(store.fileBytes) }] : runs,
  $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
} as unknown as PrismaClient;

/** The operator's own host, as the shipped stack runs it: the provider reports no metering. */
const sandbox = {} as SandboxProvider;
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

async function subscribe(
  { provider, billing }: ReturnType<typeof setup>,
  tier: "pro" | "max" = "pro",
) {
  await billing.checkout(actor, undefined, "month", tier);
  const checkout = provider.byokCheckouts.get(store.account!.customerId);
  provider.completeByokCheckout(store.account!.customerId);
  await billing.syncForActor(actor);
  return checkout;
}

beforeEach(() => {
  store.account = null;
  store.credits = { organizationId: "org-1", mode: null, balanceMicros: 0n, byokFreeUntil: null };
  store.billingOn = true;
  store.trialHolds = 0;
  store.fileBytes = 0;
  runs.length = 0;
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

  it("makes Free cost nothing and include no hosted computer", () => {
    expect(BYOK_TIERS.standard).toMatchObject({
      monthlyPriceCents: null,
      annualPriceCents: null,
      computerAllowanceCents: 0,
    });
    expect(byokTierPriceCents("standard", "month")).toBeNull();
  });

  it("still sells the paid plans, with a computer allowance each", () => {
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

  it("is offered Premium and Premium Plus, not Free, as plans to buy", async () => {
    const { billing } = setup();
    const { byokTiers } = await billing.status(actor);
    expect(byokTiers?.map((offer) => [offer.tier, offer.name])).toEqual([
      ["pro", "Premium"],
      ["max", "Premium Plus"],
    ]);
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
  it("pays the plan's price from the first day, without a trial", async () => {
    const context = setup();
    const checkout = await subscribe(context);
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
    await subscribe(context);
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
    await subscribe(context);
    await context.billing.syncForActor(actor);
    expect(context.provider.subscriptions).toHaveLength(1);
    expect(context.provider.subscriptions[0]).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });

  it("uses up its hours on the operator's own host too", async () => {
    const context = setup();
    await subscribe(context);
    const hours = sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents);
    runs.push({ kind: "docker", hours: hours - 1 });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
    await expect(context.billing.status(actor)).resolves.toMatchObject({ computerHoursLeft: 1 });
    runs.push({ kind: "docker", hours: 1 });
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(true);
  });

  it("gets the plan's computer hours and size", async () => {
    const context = setup();
    await subscribe(context);
    const status = await context.billing.status(actor);
    expect(status.computerHoursLeft).toBe(
      sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents),
    );
    await expect(sandboxAllowanceUsedUp({ prisma, sandbox }, hostedComputer)).resolves.toBe(false);
    await expect(planComputerSize(prisma, "space-1")).resolves.toBe(BYOK_TIERS.pro.computerSize);
  });

  it("can move to Premium Plus but not to Free, which is cancelling", async () => {
    const context = setup();
    await subscribe(context);
    await context.billing.changeTier(actor, "max");
    await expect(context.billing.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      byokPriceCents: BYOK_TIERS.max.monthlyPriceCents,
    });
    await expect(context.billing.changeTier(actor, "standard")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("falls back to Free when the subscription ends: bots run, the computer does not", async () => {
    const context = setup();
    await subscribe(context);
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
    await expect(planComputerSize(prisma, "space-1")).resolves.toBe("standard");
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
