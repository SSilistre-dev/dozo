import { tierInForce } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { statusPlanEnd } from "./dozo-plan-end.js";

// Runs on the branded tree only: `@rakazo/db` exports the grant rules once the brand rules apply.

const now = new Date("2026-11-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const day = (days: number) => new Date(now.getTime() + days * DAY);
const iso = (days: number) => day(days).toISOString();

/** A live subscription, renewing at the end of its period unless cancelled. */
const subscription = (
  byokTier: string | null,
  periodDays: number,
  more: Partial<{ status: string; cancelAtPeriodEnd: boolean; trialEndsAt: Date | null }> = {},
) => ({
  status: "active",
  byokTier,
  trialEndsAt: null,
  currentPeriodEndsAt: day(periodDays),
  cancelAtPeriodEnd: false,
  ...more,
});
const grant = (tier: string, days: number) => ({ tier, endsAt: day(days) });

describe("statusPlanEnd, one source at a time", () => {
  it("has no end without a subscription, a grant or a free period", () => {
    expect(statusPlanEnd(null, null, null, now)).toBeUndefined();
  });

  it("renews a subscription at the end of its period, or ends it there when cancelled", () => {
    expect(statusPlanEnd(subscription("pro", 20), null, null, now)).toEqual({
      at: iso(20),
      renews: true,
    });
    expect(
      statusPlanEnd(subscription("pro", 20, { cancelAtPeriodEnd: true }), null, null, now),
    ).toEqual({ at: iso(20), renews: false });
  });

  it("takes a trial's end while it runs", () => {
    const trial = subscription("pro", 20, { status: "trialing", trialEndsAt: day(5) });
    expect(statusPlanEnd(trial, null, null, now)).toEqual({ at: iso(5), renews: true });
    expect(
      statusPlanEnd({ ...trial, trialEndsAt: null, cancelAtPeriodEnd: true }, null, null, now),
    ).toEqual({ at: iso(20), renews: false });
  });

  it("ends a granted plan on its date, never renewing", () => {
    expect(statusPlanEnd(null, null, grant("max", 3), now)).toEqual({ at: iso(3), renews: false });
  });

  it("ends a free period on its date", () => {
    expect(statusPlanEnd(null, day(10), null, now)).toEqual({ at: iso(10), renews: false });
  });

  it("ignores a subscription without access or without a period end", () => {
    expect(
      statusPlanEnd(subscription("pro", 20, { status: "canceled" }), null, null, now),
    ).toBeUndefined();
    expect(
      statusPlanEnd({ ...subscription("pro", 20), currentPeriodEndsAt: null }, null, null, now),
    ).toBeUndefined();
  });
});

describe("statusPlanEnd, which source wins", () => {
  it("takes a grant above the subscription: the plan in force ends with the grant", () => {
    expect(statusPlanEnd(subscription("pro", 20), null, grant("max", 3), now)).toEqual({
      at: iso(3),
      renews: false,
    });
    // A subscription on credits has no tier of its own, so any grant is above it.
    expect(statusPlanEnd(subscription(null, 20), null, grant("pro", 3), now)).toEqual({
      at: iso(3),
      renews: false,
    });
  });

  it("takes a subscription above the grant", () => {
    expect(statusPlanEnd(subscription("max", 20), null, grant("pro", 3), now)).toEqual({
      at: iso(20),
      renews: true,
    });
  });

  it("keeps the same tier as long as either gives it", () => {
    expect(statusPlanEnd(subscription("pro", 20), null, grant("pro", 40), now)).toEqual({
      at: iso(20),
      renews: true,
    });
    const cancelled = subscription("pro", 20, { cancelAtPeriodEnd: true });
    expect(statusPlanEnd(cancelled, null, grant("pro", 40), now)).toEqual({
      at: iso(40),
      renews: false,
    });
    expect(statusPlanEnd(cancelled, null, grant("pro", 3), now)).toEqual({
      at: iso(20),
      renews: false,
    });
  });

  it("puts a grant before a free period", () => {
    expect(statusPlanEnd(null, day(10), grant("pro", 3), now)).toEqual({
      at: iso(3),
      renews: false,
    });
  });
});

describe("a granted plan whose end has passed", () => {
  it("has no end to show and leaves the subscription's or nothing", () => {
    expect(statusPlanEnd(null, null, grant("max", -1), now)).toBeUndefined();
    expect(statusPlanEnd(subscription("pro", 20), null, grant("max", -1), now)).toEqual({
      at: iso(20),
      renews: true,
    });
  });

  it("is Free again: no tier in force but what is paid for", () => {
    expect(tierInForce(null, grant("max", -1), now)).toBeNull();
    expect(tierInForce("pro", grant("max", -1), now)).toBe("pro");
    expect(tierInForce(null, { tier: "max", endsAt: now }, now)).toBeNull();
    expect(tierInForce(null, grant("max", 1), now)).toBe("max");
  });
});
