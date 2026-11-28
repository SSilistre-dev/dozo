// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import {
  bindPlanIntent,
  clearPlanIntent,
  PLAN_INTENT_TTL_MS,
  planIntentFromParams,
  readPlanIntent,
  savePlanIntent,
} from "./dozo-plan-intent";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

/** A value as the store holds it, kept for the next half hour unless `expiresAt` says otherwise. */
const store = (value: unknown, expiresAt = Date.now() + PLAN_INTENT_TTL_MS / 2) =>
  window.localStorage.setItem("dozo:plan-intent", JSON.stringify({ value, expiresAt }));

it.each([
  ["premium", "month", { tier: "pro", period: "month" }],
  ["premium", "year", { tier: "pro", period: "year" }],
  ["premium", null, { tier: "pro", period: "month" }],
  ["premium", "weekly", { tier: "pro", period: "month" }],
  ["premium", "YEAR", { tier: "pro", period: "month" }],
])("reads plan %j and period %j as a paid pick", (plan, period, intent) => {
  expect(planIntentFromParams(plan, period)).toEqual(intent);
});

it.each([
  null,
  "",
  "free",
  "standard",
  "pro",
  "max",
  // Premium Plus is not offered: a link that still names it is no pick.
  "premium_plus",
  "Premium",
  "premium ",
  "__proto__",
  "constructor",
  "toString",
])("ignores %j as a plan", (plan) => {
  expect(planIntentFromParams(plan, "year")).toBeNull();
});

it("keeps a pick for this browser until it is cleared", () => {
  expect(readPlanIntent()).toBeNull();
  savePlanIntent({ tier: "pro", period: "year" });
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });
  expect(readPlanIntent("anyone")).toEqual({ tier: "pro", period: "year" });
  clearPlanIntent();
  expect(readPlanIntent()).toBeNull();
});

it("gives an unclaimed pick to the first account and hides it from every other", () => {
  savePlanIntent({ tier: "pro", period: "month" });
  expect(bindPlanIntent("user-a")).toEqual({ tier: "pro", period: "month" });
  expect(bindPlanIntent("user-a")).toEqual({ tier: "pro", period: "month" });
  expect(readPlanIntent("user-a")).toEqual({ tier: "pro", period: "month" });
  expect(readPlanIntent("user-b")).toBeNull();
  expect(bindPlanIntent("user-b")).toBeNull();
  expect(readPlanIntent()).toBeNull();
});

it("keeps a pick for another tab of the same browser", () => {
  savePlanIntent({ tier: "pro", period: "year" });
  // A new tab starts with its own empty session storage; the pick is not kept there.
  window.sessionStorage.clear();
  expect(bindPlanIntent("user-a")).toEqual({ tier: "pro", period: "year" });
});

it("removes a pick older than an hour when it is read", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  savePlanIntent({ tier: "pro", period: "month" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS + 1);
  expect(readPlanIntent()).toBeNull();
  expect(window.localStorage.getItem("dozo:plan-intent")).toBeNull();
});

it("forgets a pick after an hour", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  savePlanIntent({ tier: "pro", period: "year" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS);
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS + 1);
  expect(readPlanIntent()).toBeNull();
  expect(bindPlanIntent("user-a")).toBeNull();
  expect(window.localStorage.getItem("dozo:plan-intent")).toBeNull();
});

it("counts a pick kept for longer than an hour from now as none", () => {
  store({ tier: "pro", period: "month" }, Date.now() + PLAN_INTENT_TTL_MS + 60_000);
  expect(readPlanIntent()).toBeNull();
});

it("does not keep a pick longer once an account claims it", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  savePlanIntent({ tier: "pro", period: "month" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS / 2);
  expect(bindPlanIntent("user-a")).toEqual({ tier: "pro", period: "month" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS + 1);
  expect(readPlanIntent("user-a")).toBeNull();
});

it.each([
  "not json",
  "null",
  "7",
  '"pro"',
  "{}",
  '{"value":{"tier":"pro","period":"month"}}',
  '{"value":{"tier":"pro","period":"month"},"expiresAt":"soon"}',
  '{"tier":"pro","period":"month","savedAt":1}',
])("reads %j written by anything else on the site as no pick, and removes it", (raw) => {
  window.localStorage.setItem("dozo:plan-intent", raw);
  expect(readPlanIntent()).toBeNull();
  expect(window.localStorage.getItem("dozo:plan-intent")).toBeNull();
});

it.each([
  null,
  "pro",
  {},
  { tier: "standard", period: "month" },
  { tier: "pro", period: "week" },
  { tier: "pro" },
  { tier: "premium", period: "month" },
  { tier: "pro", period: "month", userId: 7 },
])("reads a kept %j as no pick, and removes it", (value) => {
  store(value);
  expect(readPlanIntent()).toBeNull();
  expect(window.localStorage.getItem("dozo:plan-intent")).toBeNull();
});

it("has no pick where storage is refused, and saves none where it is full", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(() => savePlanIntent({ tier: "pro", period: "month" })).not.toThrow();
  expect(readPlanIntent()).toBeNull();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(() => clearPlanIntent()).not.toThrow();
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(readPlanIntent()).toBeNull();
  expect(() => savePlanIntent({ tier: "pro", period: "month" })).not.toThrow();
  expect(() => clearPlanIntent()).not.toThrow();
});

it("tells who claims a pick only when it is claimed", () => {
  const claimed = vi.fn();
  savePlanIntent({ tier: "pro", period: "year" });
  expect(bindPlanIntent("user-a", claimed)).toEqual({ tier: "pro", period: "year" });
  expect(bindPlanIntent("user-a", claimed)).toEqual({ tier: "pro", period: "year" });
  expect(bindPlanIntent("user-b", claimed)).toBeNull();
  expect(claimed.mock.calls).toEqual([[{ tier: "pro", period: "year" }]]);
});
