import { BYOK_TIERS } from "@rakazo/contracts";
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
  it("has no end without a subscription or a grant", () => {
    expect(statusPlanEnd(null, null, now)).toBeUndefined();
  });

  it("renews a subscription at the end of its period, or ends it there when cancelled", () => {
    expect(statusPlanEnd(subscription("pro", 20), null, now)).toEqual({
      at: iso(20),
      renews: true,
    });
    const cancelled = subscription("pro", 20, { cancelAtPeriodEnd: true });
    expect(statusPlanEnd(cancelled, null, now)).toEqual({ at: iso(20), renews: false });
  });

  it("takes a trial's end while it runs", () => {
    const trial = subscription("pro", 20, { status: "trialing", trialEndsAt: day(5) });
    expect(statusPlanEnd(trial, null, now)).toEqual({ at: iso(5), renews: true });
    const cancelled = { ...trial, trialEndsAt: null, cancelAtPeriodEnd: true };
    expect(statusPlanEnd(cancelled, null, now)).toEqual({ at: iso(20), renews: false });
  });

  it("ends a granted plan on its date, never renewing", () => {
    expect(statusPlanEnd(null, grant("max", 3), now)).toEqual({ at: iso(3), renews: false });
  });

  it("ignores a subscription without access or without a period end", () => {
    const canceled = subscription("pro", 20, { status: "canceled" });
    expect(statusPlanEnd(canceled, null, now)).toBeUndefined();
    const noEnd = { ...subscription("pro", 20), currentPeriodEndsAt: null };
    expect(statusPlanEnd(noEnd, null, now)).toBeUndefined();
  });

  it("has no end once a subscription's period or trial is past, as a late webhook leaves it", () => {
    const pastDue = subscription("pro", -1, { status: "past_due" });
    expect(statusPlanEnd(pastDue, null, now)).toBeUndefined();
    const trial = subscription("pro", 20, { status: "trialing", trialEndsAt: day(-2) });
    expect(statusPlanEnd(trial, null, now)).toBeUndefined();
  });
});

describe("statusPlanEnd, which source wins", () => {
  it("ends a grant above the subscription on its date and names the plan that follows", () => {
    expect(statusPlanEnd(subscription("pro", 20), grant("max", 3), now)).toEqual({
      at: iso(3),
      renews: false,
      fallsTo: { from: BYOK_TIERS.max.name, to: BYOK_TIERS.pro.name },
    });
    // Also when the subscription's own period has no date to come.
    expect(statusPlanEnd(subscription("pro", -1), grant("max", 3), now)).toMatchObject({
      fallsTo: { from: BYOK_TIERS.max.name, to: BYOK_TIERS.pro.name },
    });
  });

  it("ends a grant above a subscription that gives no tier with nothing after it", () => {
    // A subscription on credits has no tier of its own; an unpaid one counts for none.
    expect(statusPlanEnd(subscription(null, 20), grant("pro", 3), now)).toEqual({
      at: iso(3),
      renews: false,
    });
    const unpaid = subscription("pro", 20, { status: "unpaid" });
    expect(statusPlanEnd(unpaid, grant("pro", 3), now)).toEqual({ at: iso(3), renews: false });
  });

  it("takes a subscription above the grant", () => {
    expect(statusPlanEnd(subscription("max", 20), grant("pro", 3), now)).toEqual({
      at: iso(20),
      renews: true,
    });
    expect(statusPlanEnd(subscription("max", -1), grant("pro", 3), now)).toBeUndefined();
  });

  it("keeps the same tier as long as either gives it", () => {
    expect(statusPlanEnd(subscription("pro", 20), grant("pro", 40), now)).toEqual({
      at: iso(20),
      renews: true,
    });
    const cancelled = subscription("pro", 20, { cancelAtPeriodEnd: true });
    expect(statusPlanEnd(cancelled, grant("pro", 40), now)).toEqual({ at: iso(40), renews: false });
    expect(statusPlanEnd(cancelled, grant("pro", 3), now)).toEqual({ at: iso(20), renews: false });
    const stale = subscription("pro", -1, { cancelAtPeriodEnd: true });
    expect(statusPlanEnd(stale, grant("pro", 3), now)).toEqual({ at: iso(3), renews: false });
  });
});

describe("a granted plan whose end has passed", () => {
  it("has no end to show and leaves the subscription's or nothing", () => {
    expect(statusPlanEnd(null, grant("max", -1), now)).toBeUndefined();
    expect(statusPlanEnd(subscription("pro", 20), grant("max", -1), now)).toEqual({
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
