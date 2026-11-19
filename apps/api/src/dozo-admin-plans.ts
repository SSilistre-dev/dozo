import type { DozoPaymentLedger } from "@rakazo/adapters";
import type { ByokTier, DozoAdminPlanRow } from "@rakazo/contracts";
import { BYOK_TIERS, ByokTierSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PlanQuotas } from "@rakazo/db";
import {
  changePlanQuota,
  codePlanLimits,
  codePlanQuota,
  readPlanQuotas,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import { readBillingSummary } from "./dozo-admin-billing.js";
import { withComputerSpecs } from "./dozo-computer-size.js";
import type { RouterContext } from "./routes/context.js";

/** The currency every plan price is billed in. */
const PLAN_CURRENCY = "usd";

/** A plan whose terms give it no computer hours has no hosted computer (Free). */
function planHasComputer(tier: ByokTier): boolean {
  return codePlanLimits(tier).computerAllowanceCents > 0;
}

/**
 * The admin plans page: each plan's prices and price keys as the code and the payment provider
 * have them (read only), its machine as the server's computer provider starts it, the quotas an
 * admin may change, and how many members are on it, counted as the billing summary counts them.
 * Refused unless the caller is a deployment admin.
 */
export function dozoAdminPlansRoutes(ctx: RouterContext, payments: DozoPaymentLedger | undefined) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    return next();
  });

  function row(
    tier: ByokTier,
    quotas: PlanQuotas,
    members: number,
    computer: DozoAdminPlanRow["computer"],
  ): DozoAdminPlanRow {
    const terms = BYOK_TIERS[tier];
    const code = codePlanQuota(tier);
    const quota = quotas[tier];
    const priceKey = (interval: "month" | "year", amountCents: number | null) =>
      amountCents === null || !payments?.priceKey
        ? null
        : payments.priceKey({ tier, interval, amountCents });
    const hasComputer = planHasComputer(tier);
    return {
      tier,
      name: terms.name,
      monthlyPriceCents: terms.monthlyPriceCents,
      annualPriceCents: terms.annualPriceCents,
      currency: PLAN_CURRENCY,
      priceKeys: {
        month: priceKey("month", terms.monthlyPriceCents),
        year: priceKey("year", terms.annualPriceCents),
      },
      computer: hasComputer ? computer : null,
      sharedSpaceMb: {
        value: quota.sharedSpaceMb ?? code.sharedSpaceMb,
        terms: code.sharedSpaceMb,
        set: quota.sharedSpaceMb !== null,
      },
      computerHours: {
        value: quota.computerHours ?? code.computerHours,
        terms: code.computerHours,
        set: quota.computerHours !== null,
      },
      computerHoursEditable: hasComputer,
      members,
    };
  }

  async function list() {
    const [summary, quotas] = await Promise.all([
      runAsSystem("count plans for the admin page", () => readBillingSummary(prisma)),
      readPlanQuotas(prisma),
    ]);
    const tiers = ByokTierSchema.options;
    const machines = withComputerSpecs(
      tiers.map((tier) => ({ tier, computerSize: BYOK_TIERS[tier].computerSize })),
      deps.sandbox,
    );
    return {
      plans: tiers.map((tier, index) =>
        row(
          tier,
          quotas,
          summary.plans.find((count) => count.tier === tier)?.total ?? 0,
          machines[index]?.computerSpec ?? null,
        ),
      ),
    };
  }

  return {
    list: admin.dozoAdmin.plans.list.handler(list),

    /**
     * Each quota that changed is one audit event (who, plan, from and to), written in the change's
     * own transaction. Every limit reads the quotas from the database, so the change holds on every
     * instance at once. Lowering one deletes nothing.
     */
    setQuota: admin.dozoAdmin.plans.setQuota.handler(async ({ context, input }) => {
      if (input.computerHours !== undefined && !planHasComputer(input.tier))
        throw new ClientError("BAD_REQUEST", "This plan has no computer");
      const { before, after } = await changePlanQuota(
        prisma,
        input.tier,
        { sharedSpaceMb: input.sharedSpaceMb, computerHours: input.computerHours },
        context.actor.userId,
      );
      for (const quota of ["sharedSpaceMb", "computerHours"] as const)
        if (before[quota] !== after[quota])
          getLogger().info("dozo.admin.plan_quota", {
            "admin.id": context.actor.userId,
            tier: input.tier,
            quota,
          });
      return list();
    }),
  };
}
