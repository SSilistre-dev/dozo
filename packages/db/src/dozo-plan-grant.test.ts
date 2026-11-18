import {
  BYOK_TIERS,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  TRIAL_SANDBOX_ALLOWANCE_CENTS,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  DOZO_PLAN_GRANT_SELECT,
  grantedAllowanceCents,
  grantInForce,
  paidTierOf,
  planGrantOf,
  revokePlanGrant,
  setPlanGrant,
  tierInForce,
} from "./dozo-plan-grant.js";
import { planComputerSize, sandboxAllowancePlan } from "./sandbox-allowance.js";

// Runs on the branded tree only: the plans exist once the brand rules are applied.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const at = (iso: string) => new Date(iso);
const later = new Date("2026-06-02T12:00:00.000Z");
const earlier = new Date("2026-05-31T12:00:00.000Z");
// The machine size is asked for at the moment of asking, so its grants end far ahead.
const far = new Date("2999-01-01T00:00:00.000Z");

describe("the tier in force", () => {
  it("is the paid tier without a grant", () => {
    expect(tierInForce(null, null, NOW)).toBeNull();
    expect(tierInForce("pro", undefined, NOW)).toBe("pro");
    expect(tierInForce("standard", null, NOW)).toBe("standard");
  });

  it("counts a grant that has not ended", () => {
    expect(tierInForce(null, { tier: "pro", endsAt: later }, NOW)).toBe("pro");
    expect(tierInForce("standard", { tier: "max", endsAt: later }, NOW)).toBe("max");
  });

  it("drops a grant that has ended, the moment it ends included", () => {
    expect(tierInForce(null, { tier: "pro", endsAt: earlier }, NOW)).toBeNull();
    expect(tierInForce(null, { tier: "pro", endsAt: NOW }, NOW)).toBeNull();
    expect(
      tierInForce("standard", { tier: "max", endsAt: at("2026-06-01T12:00:00.001Z") }, NOW),
    ).toBe("max");
  });

  it("takes the higher of the paid tier and the grant's", () => {
    expect(tierInForce("max", { tier: "pro", endsAt: later }, NOW)).toBe("max");
    expect(tierInForce("pro", { tier: "max", endsAt: later }, NOW)).toBe("max");
    expect(tierInForce("pro", { tier: "pro", endsAt: later }, NOW)).toBe("pro");
    expect(tierInForce("max", { tier: "pro", endsAt: earlier }, NOW)).toBe("max");
  });

  it("ignores a grant whose tier is not one an admin can give", () => {
    for (const tier of ["", "gold", "PRO", "standard"])
      expect(tierInForce(null, { tier, endsAt: later }, NOW)).toBeNull();
    expect(tierInForce("pro", { tier: "gold", endsAt: later }, NOW)).toBe("pro");
  });

  it("reads the clock when none is given", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(tierInForce(null, { tier: "pro", endsAt: new Date(Date.now() + day) })).toBe("pro");
    expect(tierInForce(null, { tier: "pro", endsAt: new Date(Date.now() - day) })).toBeNull();
    expect(grantInForce({ tier: "max", endsAt: new Date(Date.now() + day) })?.tier).toBe("max");
  });

  it("says which grant counts and until when", () => {
    expect(grantInForce({ tier: "max", endsAt: later }, NOW)).toEqual({
      tier: "max",
      endsAt: later,
    });
    expect(grantInForce({ tier: "max", endsAt: earlier }, NOW)).toBeNull();
    expect(grantInForce(null, NOW)).toBeNull();
  });
});

describe("the tier a subscription pays for", () => {
  it("is its own tier while it is live, and nothing otherwise", () => {
    for (const status of ["trialing", "active", "past_due"])
      expect(paidTierOf({ status, byokTier: "pro" })).toBe("pro");
    for (const status of ["canceled", "incomplete", null])
      expect(paidTierOf({ status, byokTier: "pro" })).toBeNull();
    expect(paidTierOf({ status: "active", byokTier: null })).toBeNull();
    expect(paidTierOf({ status: "active", byokTier: "unknown" })).toBeNull();
    expect(paidTierOf(null)).toBeNull();
    expect(paidTierOf(undefined)).toBeNull();
  });
});

describe("writing a grant", () => {
  function store() {
    const rows = new Map<string, Record<string, unknown>>();
    const dozoPlanGrant = {
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        const row = rows.get(where.organizationId);
        return row ? { tier: row.tier, endsAt: row.endsAt } : null;
      }),
      upsert: vi.fn(
        async (args: {
          where: { organizationId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const row = rows.get(args.where.organizationId);
          rows.set(args.where.organizationId, row ? { ...row, ...args.update } : args.create);
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { organizationId: string } }) => ({
        count: rows.delete(where.organizationId) ? 1 : 0,
      })),
    };
    return { rows, prisma: { dozoPlanGrant } as unknown as Pick<PrismaClient, "dozoPlanGrant"> };
  }

  it("sets, replaces and ends the grant of one organization", async () => {
    const { rows, prisma } = store();
    await setPlanGrant(prisma, {
      organizationId: "org-1",
      tier: "pro",
      endsAt: later,
      grantedById: "admin",
      note: "press",
    });
    expect(rows.get("org-1")).toEqual({
      organizationId: "org-1",
      tier: "pro",
      endsAt: later,
      grantedById: "admin",
      note: "press",
    });
    await setPlanGrant(prisma, {
      organizationId: "org-1",
      tier: "max",
      endsAt: at("2027-01-01T00:00:00.000Z"),
      grantedById: "other",
    });
    expect(rows.get("org-1")).toMatchObject({
      tier: "max",
      endsAt: at("2027-01-01T00:00:00.000Z"),
      grantedById: "other",
      note: null,
    });
    expect(rows.size).toBe(1);
    await expect(planGrantOf(prisma, "org-1")).resolves.toEqual({
      tier: "max",
      endsAt: at("2027-01-01T00:00:00.000Z"),
    });
    expect(prisma.dozoPlanGrant.findUnique).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      select: DOZO_PLAN_GRANT_SELECT,
    });
    await expect(revokePlanGrant(prisma, "org-1")).resolves.toBe(true);
    await expect(revokePlanGrant(prisma, "org-1")).resolves.toBe(false);
    await expect(planGrantOf(prisma, "org-1")).resolves.toBeNull();
  });
});

type Billing = {
  creditAmountCents?: number | null;
  status: string | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodStartsAt?: Date | null;
  currentPeriodEndsAt?: Date | null;
  byokInterval?: string | null;
  byokTier: string | null;
  byokPriceCents: number | null;
} | null;

/** One organization as the allowance and the machine size read it. */
function organization(
  init: {
    mode?: string | null;
    billing?: Billing;
    grant?: { tier: string; endsAt: Date } | null;
    /** Credit an admin granted without a monthly plan, in cents. */
    pool?: number | null;
  } = {},
) {
  const state = {
    mode: "byok" as string | null,
    billing: null as Billing,
    grant: null as { tier: string; endsAt: Date } | null,
    pool: null as number | null,
    ...init,
  };
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ modelCreditsEnabled: true }) },
    organization: {
      findUnique: async () => ({
        modelCredits: { mode: state.mode },
        billing: state.billing,
        dozoPlanGrant: state.grant,
      }),
    },
    space: {
      findUnique: async () => ({
        organization: {
          modelCredits: { mode: state.mode },
          billing: state.billing,
          dozoPlanGrant: state.grant,
        },
      }),
    },
    accessGrant: {
      aggregate: async () => ({
        _sum: { creditCents: state.pool },
        _min: { appliedAt: state.pool ? earlier : null },
      }),
    },
  } as unknown as PrismaClient;
  return { state, prisma };
}

const paid = (byokTier: string, status = "active"): NonNullable<Billing> => ({
  status,
  byokTier,
  byokPriceCents: 1000,
});

describe("the computer a granted plan gives", () => {
  const limit = async (prisma: PrismaClient) =>
    (await sandboxAllowancePlan(prisma, "org-1", NOW))?.limitCents;

  it("is none on Free, and the granted plan's allowance and size while it lasts", async () => {
    const { prisma, state } = organization();
    expect(await limit(prisma)).toBe(0);
    await expect(planComputerSize(prisma, "space-1")).resolves.toBe("standard");

    state.grant = { tier: "pro", endsAt: far };
    expect(await limit(prisma)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
    await expect(planComputerSize(prisma, "space-1")).resolves.toBe(BYOK_TIERS.pro.computerSize);

    state.grant = { tier: "max", endsAt: far };
    expect(await limit(prisma)).toBe(BYOK_TIERS.max.computerAllowanceCents);
  });

  it("measures the end against the moment it is asked for", async () => {
    const { prisma } = organization({ grant: { tier: "pro", endsAt: NOW } });
    expect(await limit(prisma)).toBe(0);
    expect((await sandboxAllowancePlan(prisma, "org-1", earlier))?.limitCents).toBe(
      BYOK_TIERS.pro.computerAllowanceCents,
    );
  });

  it("is none again once it has ended", async () => {
    const { prisma } = organization({ grant: { tier: "max", endsAt: earlier } });
    expect(await limit(prisma)).toBe(0);
    await expect(planComputerSize(prisma, "space-1")).resolves.toBe("standard");
  });

  it("follows the higher of the subscription and the grant", async () => {
    const { prisma, state } = organization({
      billing: paid("pro"),
      grant: { tier: "max", endsAt: later },
    });
    expect(await limit(prisma)).toBe(BYOK_TIERS.max.computerAllowanceCents);
    state.grant = { tier: "pro", endsAt: later };
    state.billing = paid("max");
    expect(await limit(prisma)).toBe(BYOK_TIERS.max.computerAllowanceCents);
    // The subscription ends; the grant carries on.
    state.billing = paid("max", "canceled");
    expect(await limit(prisma)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
  });

  const trial = (cancelAtPeriodEnd: boolean): NonNullable<Billing> => ({
    ...paid("pro", "trialing"),
    cancelAtPeriodEnd,
  });
  const credits = (creditAmountCents: number): NonNullable<Billing> => ({
    status: "active",
    byokTier: null,
    byokPriceCents: null,
    creditAmountCents,
  });
  const share = (cents: number) => Math.floor((cents * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100);

  it("raises a trial's allowance, a cancelled trial's included, and never lowers it", async () => {
    const trialing = organization({ billing: trial(false) });
    expect(await limit(trialing.prisma)).toBe(TRIAL_SANDBOX_ALLOWANCE_CENTS);
    trialing.state.grant = { tier: "max", endsAt: later };
    expect(await limit(trialing.prisma)).toBe(
      Math.max(TRIAL_SANDBOX_ALLOWANCE_CENTS, BYOK_TIERS.max.computerAllowanceCents),
    );
    const cancelled = organization({ billing: trial(true) });
    expect(await limit(cancelled.prisma)).toBe(0);
    cancelled.state.grant = { tier: "pro", endsAt: later };
    expect(await limit(cancelled.prisma)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
    cancelled.state.grant = { tier: "pro", endsAt: earlier };
    expect(await limit(cancelled.prisma)).toBe(0);
  });

  it("does not lower what a monthly credit plan or granted credit already gives", async () => {
    const big = 1_000_000;
    const monthly = organization({ mode: "credits", billing: credits(big) });
    expect(await limit(monthly.prisma)).toBe(share(big));
    monthly.state.grant = { tier: "max", endsAt: later };
    expect(await limit(monthly.prisma)).toBe(share(big));
    const small = organization({ mode: "credits", billing: credits(100) });
    small.state.grant = { tier: "pro", endsAt: later };
    expect(await limit(small.prisma)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
    const pool = organization({ mode: "credits", pool: big });
    expect(await limit(pool.prisma)).toBe(share(big));
    pool.state.grant = { tier: "max", endsAt: later };
    expect(await limit(pool.prisma)).toBe(share(big));
  });

  it("changes nothing without a grant, or with an ended one", async () => {
    expect(await limit(organization({ billing: trial(false) }).prisma)).toBe(
      TRIAL_SANDBOX_ALLOWANCE_CENTS,
    );
    expect(await limit(organization({ billing: trial(true) }).prisma)).toBe(0);
    expect(await limit(organization({ mode: "credits", billing: credits(1_000_000) }).prisma)).toBe(
      share(1_000_000),
    );
    expect(grantedAllowanceCents(null, NOW)).toBe(0);
    expect(grantedAllowanceCents({ tier: "pro", endsAt: earlier }, NOW)).toBe(0);
    expect(grantedAllowanceCents({ tier: "pro", endsAt: NOW }, NOW)).toBe(0);
    expect(grantedAllowanceCents({ tier: "max", endsAt: later }, NOW)).toBe(
      BYOK_TIERS.max.computerAllowanceCents,
    );
    expect(grantedAllowanceCents({ tier: "standard", endsAt: later }, NOW)).toBe(0);
    expect(grantedAllowanceCents({ tier: "pro", endsAt: new Date(Date.now() + 1e9) })).toBe(
      BYOK_TIERS.pro.computerAllowanceCents,
    );
  });

  it("resets at the start of next month for an organization with only a grant, until it ends", async () => {
    const nextMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));
    const resetsAt = async (prisma: PrismaClient) =>
      (await sandboxAllowancePlan(prisma, "org-1", NOW))?.resetsAt;
    for (const mode of [null, "byok"]) {
      const { prisma, state } = organization({ mode, grant: { tier: "pro", endsAt: later } });
      expect(await resetsAt(prisma)).toEqual(nextMonth);
      // Once it ends, the reset is upstream's: none on Free's no allowance.
      state.grant = { tier: "pro", endsAt: earlier };
      expect(await resetsAt(prisma)).toBeNull();
    }
  });

  it("reaches an organization that has no plan of its own yet", async () => {
    const { prisma } = organization({ mode: null, grant: { tier: "pro", endsAt: later } });
    expect(await limit(prisma)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
  });
});
