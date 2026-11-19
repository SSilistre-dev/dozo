import { describe, expect, it } from "vitest";
import type { PlanLimitBilling } from "./dozo-plan-limits.js";
import {
  COMPUTERS_BUSY_MESSAGE,
  planLimitCopy,
  planLimitNotice,
  planLimitOf,
  planLimitText,
} from "./dozo-plan-limits.js";
import { COMPUTER_ALLOWANCE_USED_ERROR } from "./runs.js";

// Runs on the branded tree only: Free has no computer once the plans are laid over the tiers.

const offers = [
  {
    tier: "pro" as const,
    name: "Premium",
    monthlyPriceCents: 4900,
    annualPriceCents: null,
    computerSize: "large" as const,
    computerHours: 100,
  },
  {
    tier: "max" as const,
    name: "Premium Plus",
    monthlyPriceCents: 9900,
    annualPriceCents: null,
    computerSize: "large" as const,
    computerHours: 200,
  },
];
const billing = (over: Partial<PlanLimitBilling> = {}): PlanLimitBilling => ({
  canManage: true,
  byokTier: "standard",
  byokTiers: offers,
  funding: "byok",
  state: "none",
  ...over,
});

describe("planLimitOf", () => {
  it("reads a known code from an RPC error and ignores any other code", () => {
    expect(planLimitOf({ code: "shared_space_full", message: "x" })).toBe("shared_space_full");
    expect(planLimitOf({ code: "COMPUTERS_BUSY" })).toBe("COMPUTERS_BUSY");
    expect(planLimitOf({ code: "FORBIDDEN", message: "Nope" })).toBeNull();
  });

  it("reads a saved run error's text: the hours refusal and the busy host", () => {
    expect(planLimitOf(COMPUTER_ALLOWANCE_USED_ERROR)).toBe("computer_hours");
    expect(
      planLimitOf(
        new Error(`${COMPUTER_ALLOWANCE_USED_ERROR} The computer was saved and stopped.`),
      ),
    ).toBe("computer_hours");
    expect(planLimitOf(` ${COMPUTERS_BUSY_MESSAGE} `)).toBe("COMPUTERS_BUSY");
    expect(planLimitOf("Something else")).toBeNull();
    // A failed send keeps the sentence errorText already chose, in either language.
    expect(planLimitOf("Paylaşılan alan dolu. Dosya silin ya da planı değiştirin.")).toBe(
      "shared_space_full",
    );
    expect(planLimitOf("Shared space is full. Delete files or change the plan.")).toBe(
      "shared_space_full",
    );
    expect(planLimitOf(null)).toBeNull();
    expect(planLimitOf({ message: 42 })).toBeNull();
  });
});

describe("computer hours", () => {
  it("Free: the plan has no computer, Upgrade starts a paid plan", () => {
    expect(planLimitNotice("computer_hours", billing(), "en")).toEqual({
      code: "computer_not_in_plan",
      text: "Your plan doesn't include a computer.",
      action: { kind: "upgrade", label: "Upgrade", startsPaidPlan: true },
    });
  });

  it("a status that names no tier is on the first one, Free", () => {
    // Upstream's composer test passes a status without `byokTier`: on the branded tree it is Free.
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: undefined, state: "active" }), "en")
        ?.code,
    ).toBe("computer_not_in_plan");
  });

  it("Free, a member who cannot manage billing: ask the owner, no action", () => {
    expect(planLimitNotice("computer_hours", billing({ canManage: false }), "tr")).toEqual({
      code: "computer_not_in_plan",
      text: "Planınızda bilgisayar yok. Yükseltmesi için sahibine sorun.",
      action: null,
    });
  });

  it("Premium spent its hours: today's sentence, and the move to Premium Plus", () => {
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "pro", state: "active" }), "en"),
    ).toEqual({
      code: "computer_hours_used",
      text: "This month's computer hours are used up.",
      action: { kind: "upgrade", label: "Upgrade to Premium Plus", startsPaidPlan: false },
    });
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "pro", state: "active" }), "tr")?.action
        ?.label,
    ).toBe("Premium Plus planına geç");
  });

  it("Premium Plus spent its hours: nothing higher to offer", () => {
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "max", state: "active" }), "en"),
    ).toEqual({
      code: "computer_hours_used",
      text: "This month's computer hours are used up.",
      action: null,
    });
  });

  it("a paid plan's member gets the sentence without the action", () => {
    expect(
      planLimitNotice(
        "computer_hours",
        billing({ byokTier: "pro", state: "active", canManage: false }),
        "en",
      )?.action,
    ).toBeNull();
  });

  it("leaves trials, credit plans and an unknown status to upstream's copy", () => {
    expect(planLimitNotice("computer_hours", billing({ state: "trialing" }), "en")).toBeNull();
    expect(planLimitNotice("computer_hours", billing({ funding: "credits" }), "en")).toBeNull();
    expect(planLimitNotice("computer_hours", null, "en")).toBeNull();
    expect(planLimitText(COMPUTER_ALLOWANCE_USED_ERROR, "en")).toBeNull();
  });

  it("a plan the offers do not list has no next plan", () => {
    expect(
      planLimitNotice(
        "computer_hours",
        billing({ byokTier: "pro", state: "active", byokTiers: undefined }),
        "en",
      )?.action,
    ).toBeNull();
    expect(planLimitNotice("computer_hours", billing({ byokTiers: [] }), "en")?.action).toBeNull();
  });
});

describe("shared space full", () => {
  it("without the billing status: the neutral sentence", () => {
    expect(planLimitText({ code: "shared_space_full" }, "en")).toBe(
      "Shared space is full. Delete files or change the plan.",
    );
  });

  it("the owner on Premium: Upgrade, which changes a paid plan", () => {
    expect(
      planLimitNotice("shared_space_full", billing({ byokTier: "pro", state: "active" }), "en")
        ?.action,
    ).toEqual({ kind: "upgrade", label: "Upgrade", startsPaidPlan: false });
  });

  it("the member: ask the owner, no action", () => {
    expect(planLimitNotice("shared_space_full", billing({ canManage: false }), "tr")).toEqual({
      code: "shared_space_full",
      text: "Paylaşılan alan dolu. Dosya silin ya da yükseltmesi için sahibine sorun.",
      action: null,
    });
  });

  it("the top plan: delete files, nothing to upgrade to", () => {
    expect(
      planLimitNotice("shared_space_full", billing({ byokTier: "max", state: "active" }), "en"),
    ).toEqual({
      code: "shared_space_full",
      text: "Shared space is full. Delete files to make room.",
      action: null,
    });
  });
});

describe("the other limits", () => {
  it("busy computers: a short sentence and try again, never an upgrade", () => {
    expect(planLimitNotice("COMPUTERS_BUSY", billing(), "en")).toEqual({
      code: "COMPUTERS_BUSY",
      text: COMPUTERS_BUSY_MESSAGE,
      action: { kind: "retry", label: "Try again" },
    });
    expect(planLimitText({ code: "COMPUTERS_BUSY" }, "tr-TR")).toBe(
      "Tüm bilgisayarlar meşgul. Birazdan tekrar deneyin.",
    );
  });

  it("the computer and Space counts and a free checkout: a sentence only", () => {
    expect(planLimitText({ code: "computer_limit_reached" }, "en")).toBe(
      "Computer limit reached. Archive a bot to free one.",
    );
    expect(planLimitText({ code: "space_limit_reached" }, "en")).toBe(
      "Space limit reached. Delete a Space to add another.",
    );
    expect(planLimitText({ code: "plan_not_offered" }, "tr")).toBe(
      "Bu plan ücretsiz. Yükseltmek için ücretli bir plan seçin.",
    );
    expect(planLimitText({ code: "OTHER" }, "en")).toBeNull();
  });

  it("copy is English unless the UI is Turkish", () => {
    expect(planLimitCopy("de").upgrade).toBe("Upgrade");
    expect(planLimitCopy("tr").upgrade).toBe("Yükselt");
    expect(planLimitCopy("trx").upgrade).toBe("Upgrade");
  });

  it("every sentence has its Turkish twin", () => {
    expect(Object.keys(planLimitCopy("tr")).sort()).toEqual(
      Object.keys(planLimitCopy("en")).sort(),
    );
  });
});
