import { describe, expect, it } from "vitest";
import { PLAN_END_WARNING_DAYS, planEndDays, planEndWarns } from "./dozo-plan-end.js";

const now = new Date(2026, 10, 19, 15, 0);
/** A plan end at local noon `days` calendar days after `now`. */
const end = (days: number, renews = false) => ({
  at: new Date(2026, 10, 19 + days, 12, 0).toISOString(),
  renews,
});

describe("planEndDays", () => {
  it("counts calendar days in the viewer's time zone, 0 on the day itself", () => {
    expect(planEndDays(end(0), now)).toBe(0);
    expect(planEndDays(end(1), now)).toBe(1);
    expect(planEndDays(end(30), now)).toBe(30);
    expect(
      planEndDays({ at: new Date(2026, 10, 19, 23, 59).toISOString(), renews: false }, now),
    ).toBe(0);
  });

  it("is negative once the end has passed", () => {
    expect(planEndDays(end(-2), now)).toBe(-2);
  });
});

describe("planEndWarns", () => {
  it("warns about a plan that ends within the warning days", () => {
    expect(planEndWarns(end(PLAN_END_WARNING_DAYS), now)).toBe(true);
    expect(planEndWarns(end(0), now)).toBe(true);
    expect(planEndWarns(end(PLAN_END_WARNING_DAYS + 1), now)).toBe(false);
  });

  it("never warns about a plan that renews", () => {
    expect(planEndWarns(end(1, true), now)).toBe(false);
  });

  it("never warns about a granted plan with a paid plan after it", () => {
    const fallsTo = { from: "Premium Plus", to: "Premium" };
    expect(planEndWarns({ ...end(1), fallsTo }, now)).toBe(false);
  });
});
