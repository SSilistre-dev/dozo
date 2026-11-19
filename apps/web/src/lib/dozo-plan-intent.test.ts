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
  window.sessionStorage.clear();
});

const store = (value: unknown) =>
  window.sessionStorage.setItem("dozo:plan-intent", JSON.stringify(value));

it.each([
  ["premium", "month", { tier: "pro", period: "month" }],
  ["premium", "year", { tier: "pro", period: "year" }],
  ["premium_plus", "year", { tier: "max", period: "year" }],
  ["premium_plus", null, { tier: "max", period: "month" }],
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
  "Premium",
  "premium ",
  "__proto__",
  "constructor",
  "toString",
])("ignores %j as a plan", (plan) => {
  expect(planIntentFromParams(plan, "year")).toBeNull();
});

it("keeps a pick for the tab until it is cleared", () => {
  expect(readPlanIntent()).toBeNull();
  savePlanIntent({ tier: "max", period: "year" });
  expect(readPlanIntent()).toEqual({ tier: "max", period: "year" });
  expect(readPlanIntent("anyone")).toEqual({ tier: "max", period: "year" });
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

it("forgets a pick after an hour", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  savePlanIntent({ tier: "pro", period: "year" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS);
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });
  vi.setSystemTime(1_000_000 + PLAN_INTENT_TTL_MS + 1);
  expect(readPlanIntent()).toBeNull();
  expect(bindPlanIntent("user-a")).toBeNull();
  expect(window.sessionStorage.getItem("dozo:plan-intent")).toBeNull();
});

it("counts a pick from the future as none", () => {
  store({ tier: "pro", period: "month", savedAt: Date.now() + 60_000 });
  expect(readPlanIntent()).toBeNull();
});

it.each([
  "not json",
  "null",
  "7",
  '"pro"',
  "{}",
  '{"tier":"standard","period":"month","savedAt":1}',
  '{"tier":"pro","period":"week","savedAt":1}',
  '{"tier":"pro","savedAt":1}',
  '{"tier":"premium","period":"month","savedAt":1}',
  '{"tier":"pro","period":"month"}',
  '{"tier":"pro","period":"month","savedAt":"now"}',
])("reads %j written by anything else in the tab as no pick", (raw) => {
  window.sessionStorage.setItem("dozo:plan-intent", raw);
  expect(readPlanIntent()).toBeNull();
});

it("reads a pick claimed by something that is not an account as none", () => {
  store({ tier: "pro", period: "month", savedAt: Date.now(), userId: 7 });
  expect(readPlanIntent()).toBeNull();
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
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(readPlanIntent()).toBeNull();
  expect(() => savePlanIntent({ tier: "pro", period: "month" })).not.toThrow();
  expect(() => clearPlanIntent()).not.toThrow();
});
