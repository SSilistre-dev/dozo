import { oc } from "@orpc/contract";
import * as z from "zod";

/** How far back the funnel's sign-ups go, in days. */
export const DOZO_FUNNEL_DAYS = [7, 30, 90] as const;
export const DozoFunnelDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type DozoFunnelDays = z.infer<typeof DozoFunnelDaysSchema>;

/** The funnel's steps, in order. Each counts members who also reached every step before it. */
export const DOZO_FUNNEL_STEPS = [
  "signedUp",
  "modelConnected",
  "firstBot",
  "firstMessage",
  "paid",
] as const;
export const DozoFunnelStepSchema = z.enum(DOZO_FUNNEL_STEPS);
export type DozoFunnelStep = z.infer<typeof DozoFunnelStepSchema>;

export const DozoFunnelRowSchema = z.object({
  step: DozoFunnelStepSchema,
  members: z.number().int(),
  /** Whole percent of the step before; null on the first step or when the one before is 0. */
  rate: z.number().int().nullable(),
  /** Median time from the step before, in seconds; null on the first step or with no members. */
  medianSeconds: z.number().int().nullable(),
});
export type DozoFunnelRow = z.infer<typeof DozoFunnelRowSchema>;

/** Counted from the deployment's own records; no analytics provider is asked. */
export const DozoAdminFunnelSchema = z.object({
  days: DozoFunnelDaysSchema,
  steps: z.array(DozoFunnelRowSchema),
  /**
   * Members of the period who never paid but own an organization an admin granted a plan to.
   * A granted plan is not a paid one, so they are left out of the paid step.
   */
  granted: z.number().int(),
});
export type DozoAdminFunnel = z.infer<typeof DozoAdminFunnelSchema>;

/** Refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminFunnelContract = {
  read: oc.input(z.object({ days: DozoFunnelDaysSchema })).output(DozoAdminFunnelSchema),
};
