/** When the plan in force ends, or renews when it goes on, as the billing status carries it. */
export type PlanEnd = { at: string; renews: boolean };

/** Within this many days, a plan that ends is shown as a warning. */
export const PLAN_END_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days from `now` to the plan's end in the viewer's time zone: 0 on the day itself. */
export function planEndDays(end: PlanEnd, now = new Date()): number {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(new Date(end.at)) - day(now)) / DAY_MS);
}

/** A plan that ends, not renews, within `PLAN_END_WARNING_DAYS`. */
export function planEndWarns(end: PlanEnd, now = new Date()): boolean {
  return !end.renews && planEndDays(end, now) <= PLAN_END_WARNING_DAYS;
}
