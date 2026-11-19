import type { BillingStatus } from "./billing.js";

/**
 * When the plan in force ends, or renews when it goes on, as the billing status carries it. A
 * granted plan above a subscription names both plans in `fallsTo`: the subscription's follows.
 */
export type PlanEnd = { at: string; renews: boolean; fallsTo?: { from: string; to: string } };

/** Within this many days, a plan that ends is shown as a warning. */
export const PLAN_END_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days from `now` to the plan's end in the viewer's time zone: 0 on the day itself. */
export function planEndDays(end: PlanEnd, now = new Date()): number {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(new Date(end.at)) - day(now)) / DAY_MS);
}

/** A plan that ends within `PLAN_END_WARNING_DAYS` with nothing paid after it. */
export function planEndWarns(end: PlanEnd, now = new Date()): boolean {
  return !end.renews && !end.fallsTo && planEndDays(end, now) <= PLAN_END_WARNING_DAYS;
}

/**
 * A payment failed and this member can fix it: the subscription is past due, and they manage
 * billing for an organization the provider knows. Web and mobile show one line while it holds.
 */
export function paymentPastDue(
  status: Pick<BillingStatus, "state" | "canManage" | "hasCustomer"> | null | undefined,
): boolean {
  return Boolean(status?.state === "past_due" && status.canManage && status.hasCustomer);
}
