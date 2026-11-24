import { expect, it } from "vitest";
import { screenPending } from "./dozo-screen-pending";

it("waits only for a running computer's missing screen, and never over an error", () => {
  expect(screenPending("running", null, null)).toBe(true);
  expect(screenPending("running", "https://screen.example.test/view", null)).toBe(false);
  expect(screenPending("running", null, "Could not open computer")).toBe(false);
  expect(screenPending("suspended", null, null)).toBe(false);
  expect(screenPending("booting", null, null)).toBe(false);
  expect(screenPending(undefined, null, null)).toBe(false);
});
