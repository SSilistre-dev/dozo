import { oc } from "@orpc/contract";
import * as z from "zod";
import { ByokTierSchema } from "./billing.js";
import { Id, IsoDate } from "./ids.js";

/** How many accounts are on one plan: paid each month, paid each year, or given by an admin. */
export const DozoAdminPlanCountSchema = z.object({
  tier: ByokTierSchema,
  total: z.number().int(),
  monthly: z.number().int(),
  yearly: z.number().int(),
  granted: z.number().int(),
});
export type DozoAdminPlanCount = z.infer<typeof DozoAdminPlanCountSchema>;

/** Counted from the deployment's own records; no payment provider is asked. */
export const DozoAdminBillingSummarySchema = z.object({
  members: z.number().int(),
  /** Subscriptions that are paid up. */
  paid: z.number().int(),
  trialing: z.number().int(),
  /** Plans an admin granted that have not ended. */
  granted: z.number().int(),
  /** Free first, then each paid tier. */
  plans: z.array(DozoAdminPlanCountSchema),
  /** Trials, grants and cancelled subscriptions that end within 7 and within 30 days. */
  ending: z.object({ within7Days: z.number().int(), within30Days: z.number().int() }),
  /** Subscriptions whose payment failed and that are not settled yet. */
  pastDue: z.number().int(),
  /** Subscriptions set to end when their paid period does. */
  cancelling: z.number().int(),
});
export type DozoAdminBillingSummary = z.infer<typeof DozoAdminBillingSummarySchema>;

export const DozoAdminRevenuePeriodSchema = z.enum(["thisMonth", "lastMonth", "last12Months"]);
export type DozoAdminRevenuePeriod = z.infer<typeof DozoAdminRevenuePeriodSchema>;

/** Amounts are in the currency's minor unit (cents), as the payment provider reports them. */
export const DozoAdminRevenueTotalSchema = z.object({
  currency: z.string(),
  paid: z.number().int(),
  refunded: z.number().int(),
});

export const DozoAdminPaymentSchema = z.object({
  /** The account that pays; null when no account of this deployment owns the payer any more. */
  member: z.object({ id: Id, email: z.string() }).nullable(),
  amount: z.number().int(),
  currency: z.string(),
  at: IsoDate,
  status: z.enum(["paid", "refunded", "failed"]),
});
export type DozoAdminPayment = z.infer<typeof DozoAdminPaymentSchema>;

export const DozoAdminRevenueSchema = z.object({
  /** One row per currency paid or refunded in; null when not every record could be read. */
  totals: z.array(DozoAdminRevenueTotalSchema).nullable(),
  /** Failed payments; null when not every record could be read. */
  failed: z.number().int().nullable(),
  /**
   * Records of the deployment's payers in the period that do not show they are the deployment's:
   * another product's, or older ones without a mark. Never in the totals or the payments.
   */
  unclassified: z.number().int(),
  /** Newest first. */
  payments: z.array(DozoAdminPaymentSchema),
});
export type DozoAdminRevenue = z.infer<typeof DozoAdminRevenueSchema>;

/** Every procedure is refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminBillingContract = {
  summary: oc.output(DozoAdminBillingSummarySchema),
  /** Null when no payment provider is configured. */
  revenue: oc
    .input(z.object({ period: DozoAdminRevenuePeriodSchema }))
    .output(DozoAdminRevenueSchema.nullable()),
};
