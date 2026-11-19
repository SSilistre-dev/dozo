import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { PlanLimitBilling } from "@rakazo/contracts";
import {
  COMPUTER_ALLOWANCE_USED_ERROR,
  COMPUTERS_BUSY_MESSAGE,
  planLimitNotice,
  planLimitOf,
  planLimitText,
  SHARED_SPACE_FULL_MESSAGE,
} from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { describe, expect, it } from "vitest";

// The plan-limit table (in contracts) with the copy clients pass. Runs on the branded tree only:
// Free has no computer once the plans are laid over the tiers, and the Turkish catalog carries
// the fork's lines.

i18n.load({ en: en as Messages, de: {}, tr: tr as Messages });

/** The copy the clients pass, read from the catalogs the build ships. */
function copy(locale: string) {
  i18n.activate(locale);
  return planLimitCopy();
}

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
    expect(
      planLimitOf("Paylaşılan alan dolu. Dosya silin ya da planı değiştirin.", copy("tr")),
    ).toBe("shared_space_full");
    expect(planLimitOf("Paylaşılan alan dolu. Dosya silin ya da planı değiştirin.")).toBeNull();
    expect(planLimitOf(SHARED_SPACE_FULL_MESSAGE)).toBe("shared_space_full");
    expect(planLimitOf("Bilgisayar saatiniz kalmadı.", copy("tr"))).toBe("computer_hours");
    expect(planLimitOf(null)).toBeNull();
    expect(planLimitOf({ message: 42 })).toBeNull();
  });
});

describe("computer hours", () => {
  it("Free: the plan has no computer, Upgrade starts a paid plan", () => {
    expect(planLimitNotice("computer_hours", billing(), copy("en"))).toEqual({
      code: "computer_not_in_plan",
      text: "Your plan doesn't include a computer.",
      action: { kind: "upgrade", label: "Upgrade", startsPaidPlan: true },
    });
  });

  it("a status that names no tier is on the first one, Free", () => {
    // Upstream's composer test passes a status without `byokTier`: on the branded tree it is Free.
    expect(
      planLimitNotice(
        "computer_hours",
        billing({ byokTier: undefined, state: "active" }),
        copy("en"),
      )?.code,
    ).toBe("computer_not_in_plan");
  });

  it("Free, a member who cannot manage billing: ask the owner, no action", () => {
    expect(planLimitNotice("computer_hours", billing({ canManage: false }), copy("tr"))).toEqual({
      code: "computer_not_in_plan",
      text: "Planınızda bilgisayar yok. Yükseltmesi için sahibine sorun.",
      action: null,
    });
  });

  it("Premium spent its hours: today's sentence, and the move to Premium Plus", () => {
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "pro", state: "active" }), copy("en")),
    ).toEqual({
      code: "computer_hours_used",
      text: "This month's computer hours are used up.",
      action: { kind: "upgrade", label: "Upgrade to Premium Plus", startsPaidPlan: false },
    });
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "pro", state: "active" }), copy("tr"))
        ?.action?.label,
    ).toBe("Premium Plus planına geç");
  });

  it("Premium Plus spent its hours: nothing higher to offer", () => {
    expect(
      planLimitNotice("computer_hours", billing({ byokTier: "max", state: "active" }), copy("en")),
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
        copy("en"),
      )?.action,
    ).toBeNull();
  });

  it("leaves trials and credit plans to upstream's copy", () => {
    expect(
      planLimitNotice("computer_hours", billing({ state: "trialing" }), copy("en")),
    ).toBeNull();
    expect(
      planLimitNotice("computer_hours", billing({ funding: "credits" }), copy("en")),
    ).toBeNull();
    expect(planLimitText(COMPUTER_ALLOWANCE_USED_ERROR, copy("en"))).toBeNull();
  });

  it("without the billing status: no hours left, in the UI's language, nothing to offer", () => {
    expect(planLimitNotice("computer_hours", null, copy("tr"))).toEqual({
      code: "computer_hours_used",
      text: "Bilgisayar saatiniz kalmadı.",
      action: null,
    });
  });

  it("a plan the offers do not list has no next plan", () => {
    expect(
      planLimitNotice(
        "computer_hours",
        billing({ byokTier: "pro", state: "active", byokTiers: undefined }),
        copy("en"),
      )?.action,
    ).toBeNull();
    expect(
      planLimitNotice("computer_hours", billing({ byokTiers: [] }), copy("en"))?.action,
    ).toBeNull();
  });
});

describe("shared space full", () => {
  it("without the billing status: the neutral sentence", () => {
    expect(planLimitText({ code: "shared_space_full" }, copy("en"))).toBe(
      "Shared space is full. Delete files or change the plan.",
    );
  });

  it("the owner on Premium: Upgrade, which changes a paid plan", () => {
    expect(
      planLimitNotice(
        "shared_space_full",
        billing({ byokTier: "pro", state: "active" }),
        copy("en"),
      )?.action,
    ).toEqual({ kind: "upgrade", label: "Upgrade", startsPaidPlan: false });
  });

  it("the member: ask the owner, no action", () => {
    expect(planLimitNotice("shared_space_full", billing({ canManage: false }), copy("tr"))).toEqual(
      {
        code: "shared_space_full",
        text: "Paylaşılan alan dolu. Dosya silin ya da yükseltmesi için sahibine sorun.",
        action: null,
      },
    );
  });

  it("the top plan: delete files, nothing to upgrade to", () => {
    expect(
      planLimitNotice(
        "shared_space_full",
        billing({ byokTier: "max", state: "active" }),
        copy("en"),
      ),
    ).toEqual({
      code: "shared_space_full",
      text: "Shared space is full. Delete files to make room.",
      action: null,
    });
  });
});

describe("the other limits", () => {
  it("busy computers: a short sentence and try again, never an upgrade", () => {
    expect(planLimitNotice("COMPUTERS_BUSY", billing(), copy("en"))).toEqual({
      code: "COMPUTERS_BUSY",
      text: COMPUTERS_BUSY_MESSAGE,
      action: { kind: "retry", label: "Try again" },
    });
    expect(planLimitText({ code: "COMPUTERS_BUSY" }, copy("tr"))).toBe(
      "Tüm bilgisayarlar meşgul. Birazdan tekrar deneyin.",
    );
  });

  it("the computer and Space counts and a free checkout: a sentence only", () => {
    expect(planLimitText({ code: "computer_limit_reached" }, copy("en"))).toBe(
      "Computer limit reached. Archive a bot to free one.",
    );
    expect(planLimitText({ code: "space_limit_reached" }, copy("en"))).toBe(
      "Space limit reached. Delete a Space to add another.",
    );
    expect(planLimitText({ code: "plan_not_offered" }, copy("tr"))).toBe(
      "Bu plan ücretsiz. Yükseltmek için ücretli bir plan seçin.",
    );
    expect(planLimitText({ code: "OTHER" }, copy("en"))).toBeNull();
  });

  it("the copy follows the UI's language: English where the catalog has no line", () => {
    expect(copy("de").upgrade).toBe("Upgrade");
    expect(copy("de").upgradeTo("Premium")).toBe("Upgrade to Premium");
    expect(copy("tr").upgrade).toBe("Yükselt");
    for (const [key, text] of Object.entries(copy("tr")))
      if (typeof text === "string") expect(text, key).not.toBe(Reflect.get(copy("en"), key));
  });
});
