import { oc } from "@orpc/contract";
import * as z from "zod";
import { ByokTierSchema } from "./billing.js";
import { ComputerSizeSpecSchema } from "./dozo-computer-size.js";

/** Bounds an admin may set: ten terabytes of shared space, and every hour of a month and more. */
export const DOZO_PLAN_SHARED_SPACE_MB_MAX = 10 * 1024 * 1024;
export const DOZO_PLAN_COMPUTER_HOURS_MAX = 10_000;

/**
 * A quota as it holds: the admin's value where one is set, else the plan's terms in code. The
 * terms are what the landing page shows, so a value that differs from them is told apart.
 */
const QuotaSchema = z.object({
  value: z.number().int().nullable(),
  /** The plan's terms in code; null where the plan carries none. */
  terms: z.number().int().nullable(),
  /** An admin set it. */
  set: z.boolean(),
});

/** One plan as the admin plans page shows it. Prices are read only: they live in code. */
export const DozoAdminPlanRowSchema = z.object({
  tier: ByokTierSchema,
  name: z.string(),
  /** In cents of `currency`; null where the plan is free or not sold that way. */
  monthlyPriceCents: z.number().int().nullable(),
  annualPriceCents: z.number().int().nullable(),
  currency: z.string(),
  /** The payment provider's keys for the plan's prices; null without a provider or a price. */
  priceKeys: z.object({ month: z.string().nullable(), year: z.string().nullable() }),
  /** The machine the server's computer provider starts for it; null where it has no computer. */
  computer: ComputerSizeSpecSchema.nullable(),
  /** In MB; a null value has no limit. */
  sharedSpaceMb: QuotaSchema,
  computerHours: QuotaSchema,
  /** Free has no computer, so its hours are not an admin's to set. */
  computerHoursEditable: z.boolean(),
  /** Members on the plan now, counted as the billing summary counts them. */
  members: z.number().int(),
});
export type DozoAdminPlanRow = z.infer<typeof DozoAdminPlanRowSchema>;

/** A field left out stays as it is; null returns a quota to the plan's terms. */
export const DozoAdminPlanQuotaChangeSchema = z.object({
  tier: ByokTierSchema,
  sharedSpaceMb: z.number().int().min(0).max(DOZO_PLAN_SHARED_SPACE_MB_MAX).nullable().optional(),
  /** At least one: a paid plan's hours are what its others are compared with. */
  computerHours: z.number().int().min(1).max(DOZO_PLAN_COMPUTER_HOURS_MAX).nullable().optional(),
});
export type DozoAdminPlanQuotaChange = z.infer<typeof DozoAdminPlanQuotaChangeSchema>;

const PlansSchema = z.object({ plans: z.array(DozoAdminPlanRowSchema) });

/** Every procedure is refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminPlansContract = {
  list: oc.output(PlansSchema),
  /** Each quota that changed is audited. BAD_REQUEST for computer hours on Free. */
  setQuota: oc.input(DozoAdminPlanQuotaChangeSchema).output(PlansSchema),
};
