// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { dozoEvents: { track } } }));

import { reportEvent, reportSignupStarted, reportUpgradeViewed } from "./dozo-events";
import { savePlanIntent } from "./dozo-plan-intent";
import { markSignupStarted } from "./dozo-signup-start";

beforeEach(() => {
  track.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => window.sessionStorage.clear());

it("says where the paid plans were shown from", () => {
  reportUpgradeViewed(false);
  reportUpgradeViewed(true);
  savePlanIntent({ tier: "pro", period: "month" });
  reportUpgradeViewed(true);
  // Required to go on is the paywall, a landing pick or not.
  reportUpgradeViewed(false);
  expect(track.mock.calls.map(([event]) => event.source)).toEqual([
    "paywall",
    "app",
    "landing",
    "paywall",
  ]);
});

it("reports the sign-up form's start once, and nothing without one", () => {
  reportSignupStarted();
  expect(track).not.toHaveBeenCalled();
  markSignupStarted();
  reportSignupStarted();
  reportSignupStarted();
  expect(track.mock.calls).toEqual([[{ name: "signup_started", startedAt: expect.any(String) }]]);
});

it("loses a report that fails, without an error", async () => {
  const failed = Promise.reject(new Error("offline"));
  track.mockReturnValueOnce(failed);
  reportEvent({ name: "upgrade_viewed", source: "app" });
  await expect(failed.catch(() => "handled")).resolves.toBe("handled");
});
