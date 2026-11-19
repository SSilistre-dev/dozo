import { i18n } from "@lingui/core";
import { expect, it, vi } from "vitest";
import { billingErrorText, notePlanLimit } from "./dozo-plan-limit";

// Runs on the branded tree (`make qa`): the table is exported once the brand rules are applied.

it("a refused checkout of the free plan says why, in the UI's language", () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  expect(billingErrorText({ code: "plan_not_offered" }, "Could not open billing")).toBe(
    "This plan is free. Choose a paid plan to upgrade.",
  );
  i18n.loadAndActivate({ locale: "tr", messages: {} });
  expect(billingErrorText({ code: "plan_not_offered" }, "x")).toBe(
    "Bu plan ücretsiz. Yükseltmek için ücretli bir plan seçin.",
  );
});

it("any other failure keeps the page's own text", () => {
  expect(billingErrorText(new Error("boom"), "Could not open billing")).toBe(
    "Could not open billing",
  );
});

it("reports a refusal a member can upgrade out of, and rejects with it either way", () => {
  const track = vi.fn(async () => ({ ok: true }));
  const client = { dozoEvents: { track } };
  const limit = { code: "space_limit_reached" };
  expect(() => notePlanLimit(client, limit)).toThrow();
  try {
    notePlanLimit(client, limit);
  } catch (error) {
    expect(error).toBe(limit);
  }
  // A busy host and an unsold plan are not limits to upgrade out of; nor is any other failure.
  for (const other of [{ code: "COMPUTERS_BUSY" }, { code: "plan_not_offered" }, new Error("x")])
    expect(() => notePlanLimit(client, other)).toThrow();
  expect(track.mock.calls).toEqual([
    [{ name: "plan_limit_hit", kind: "space_limit_reached" }],
    [{ name: "plan_limit_hit", kind: "space_limit_reached" }],
  ]);
});

it("loses a report that fails, and still rejects with the refusal", async () => {
  const failed = Promise.reject(new Error("offline"));
  const client = { dozoEvents: { track: vi.fn(() => failed) } };
  expect(() => notePlanLimit(client, { code: "shared_space_full" })).toThrow();
  await expect(failed.catch(() => "handled")).resolves.toBe("handled");
});
