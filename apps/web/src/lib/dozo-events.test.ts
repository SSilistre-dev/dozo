// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ track: vi.fn(), me: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { me: api.me, dozoEvents: { track: api.track } } }));

import { forgetEventServer } from "./dozo-event-sender";
import { reportSignupStarted } from "./dozo-events";
import { markSignupStarted } from "./dozo-signup-start";

beforeEach(() => {
  forgetEventServer();
  api.me.mockReset().mockResolvedValue({ productEvents: true });
  api.track.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => window.localStorage.clear());

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
  markSignupStarted();
  reportSignupStarted();
  await vi.waitFor(() => expect(api.me).toHaveBeenCalled());
  await api.me.mock.results[0]!.value;
  expect(api.track).not.toHaveBeenCalled();
});
