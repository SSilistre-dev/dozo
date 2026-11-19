import { afterEach, describe, expect, it } from "vitest";
import {
  grantEndsAt,
  PLAN_END_WARNING_DAYS,
  paymentPastDue,
  planEndDays,
  planEndWarns,
} from "./dozo-plan-end.js";

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

describe("paymentPastDue", () => {
  const status = { state: "past_due", canManage: true, hasCustomer: true } as const;

  it("holds while the subscription is past due, for a member who manages billing", () => {
    expect(paymentPastDue(status)).toBe(true);
  });

  it("does not hold once paid, for other members, without a customer or without a status", () => {
    expect(paymentPastDue({ ...status, state: "active" })).toBe(false);
    expect(paymentPastDue({ ...status, state: "unpaid" })).toBe(false);
    expect(paymentPastDue({ ...status, canManage: false })).toBe(false);
    expect(paymentPastDue({ ...status, hasCustomer: false })).toBe(false);
    expect(paymentPastDue(null)).toBe(false);
    expect(paymentPastDue(undefined)).toBe(false);
  });
});

describe("grantEndsAt", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  // The admin picks the 26th on the 19th: every viewer sees the 26th and 7 days, early or late in
  // the day, in zones east and west of UTC and with or without daylight saving.
  const zones = [
    "UTC",
    "Europe/Istanbul",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Asia/Kolkata",
    "Australia/Sydney",
  ];
  for (const timeZone of zones) {
    it(`counts the chosen number of days and shows the chosen date in ${timeZone}`, () => {
      process.env.TZ = timeZone;
      const at = grantEndsAt("2026-11-26");
      for (const [hour, minute] of [
        [0, 5],
        [7, 0],
        [23, 30],
      ] as const) {
        const now = new Date(2026, 10, 19, hour, minute);
        expect(planEndDays({ at, renews: false }, now)).toBe(7);
      }
      expect(new Date(at).toLocaleDateString("en-CA")).toBe("2026-11-26");
    });
  }

  it("counts across a daylight saving change", () => {
    process.env.TZ = "America/New_York";
    const now = new Date(2026, 9, 30, 20, 0);
    expect(planEndDays({ at: grantEndsAt("2026-11-06"), renews: false }, now)).toBe(7);
  });

  it("is the case the old end of day got wrong", () => {
    process.env.TZ = "Europe/Istanbul";
    const now = new Date(2026, 10, 19, 7, 0);
    expect(planEndDays({ at: "2026-11-26T23:59:59.000Z", renews: false }, now)).toBe(8);
    expect(planEndDays({ at: grantEndsAt("2026-11-26"), renews: false }, now)).toBe(7);
  });
});
