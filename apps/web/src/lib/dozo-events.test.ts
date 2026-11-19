// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ track: vi.fn(), me: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { me: api.me, dozoEvents: { track: api.track } } }));

import { forgetEventServer } from "./dozo-event-sender";
import { reportSignupStarted, reportUpgradeViewed } from "./dozo-events";
import { savePlanIntent } from "./dozo-plan-intent";
import { markSignupStarted } from "./dozo-signup-start";

beforeEach(() => {
  forgetEventServer();
  api.me.mockReset().mockResolvedValue({ productEvents: true });
  api.track.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => window.sessionStorage.clear());

it("says where the paid plans were shown from", async () => {
  reportUpgradeViewed(false);
  reportUpgradeViewed(true);
  savePlanIntent({ tier: "pro", period: "month" });
  reportUpgradeViewed(true);
  // Required to go on is the paywall, a landing pick or not.
  reportUpgradeViewed(false);
  await vi.waitFor(() => expect(api.track).toHaveBeenCalledTimes(4));
  expect(api.track.mock.calls.map(([event]) => event.source)).toEqual([
    "paywall",
    "app",
    "landing",
    "paywall",
  ]);
});

it("reports the sign-up form's start once, and nothing without one", async () => {
  reportSignupStarted();
  markSignupStarted();
  reportSignupStarted();
  reportSignupStarted();
  await vi.waitFor(() => expect(api.track).toHaveBeenCalled());
  expect(api.track.mock.calls).toEqual([
    [{ name: "signup_started", startedAt: expect.any(String) }],
  ]);
});

it("reports nothing to a server without analytics", async () => {
  api.me.mockResolvedValue({ productEvents: false });
  reportUpgradeViewed(true);
  await vi.waitFor(() => expect(api.me).toHaveBeenCalled());
  await api.me.mock.results[0]!.value;
  expect(api.track).not.toHaveBeenCalled();
});
