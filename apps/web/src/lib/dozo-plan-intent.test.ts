// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import {
  clearPlanIntent,
  planIntentFromParams,
  readPlanIntent,
  savePlanIntent,
} from "./dozo-plan-intent";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

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
  clearPlanIntent();
  expect(readPlanIntent()).toBeNull();
});

it.each([
  "not json",
  "null",
  "7",
  '"pro"',
  "{}",
  '{"tier":"standard","period":"month"}',
  '{"tier":"pro","period":"week"}',
  '{"tier":"pro"}',
  '{"tier":"premium","period":"month"}',
])("reads %j written by anything else in the tab as no pick", (raw) => {
  window.sessionStorage.setItem("dozo:plan-intent", raw);
  expect(readPlanIntent()).toBeNull();
});

it("has no pick where storage is refused, and saves none where it is full", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(() => savePlanIntent({ tier: "pro", period: "month" })).not.toThrow();
  expect(readPlanIntent()).toBeNull();
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(readPlanIntent()).toBeNull();
  expect(() => savePlanIntent({ tier: "pro", period: "month" })).not.toThrow();
  expect(() => clearPlanIntent()).not.toThrow();
});
