// @vitest-environment jsdom
import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { BillingStatus, ComputerMode } from "@rakazo/contracts";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree only: Free has no computer once the plans are laid over the tiers, and
// the Turkish catalog carries the fork's lines.

const billing = vi.hoisted(() => ({
  status: null as Partial<BillingStatus> | null,
  showPlans: vi.fn(),
}));
// The macro compiles away in the build; here it translates through the loaded catalog as `t` does.
vi.mock("@lingui/react/macro", async () => {
  const { t } = await import("@lingui/core/macro");
  return { Trans: ({ children }: { children: string }) => t({ message: children }) };
});
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: billing.showPlans }),
}));

import { OwnComputerRow } from "./dozo-own-computer-row";

const offers = [
  {
    tier: "pro" as const,
    name: "Premium",
    monthlyPriceCents: 4900,
    annualPriceCents: null,
    computerSize: "large" as const,
    computerHours: 100,
  },
];
const free: Partial<BillingStatus> = {
  canManage: true,
  byokTier: "standard",
  byokTiers: offers,
  funding: null,
  state: "none",
};
const premium: Partial<BillingStatus> = { ...free, byokTier: "pro", state: "active" };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChange = vi.fn();

function show(mode: ComputerMode, refusal: string | null = null, locale = "en") {
  i18n.activate(locale);
  act(() =>
    root.render(
      <OwnComputerRow id="own" mode={mode} saving={false} refusal={refusal} onChange={onChange} />,
    ),
  );
  const toggle = host.querySelector<HTMLElement>('[role="switch"]')!;
  const line = host.querySelector("p")?.textContent ?? null;
  return { toggle, line, button: host.querySelector("p button") };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load({ en: {}, tr: tr as Messages });
  billing.status = premium;
  billing.showPlans.mockReset();
  onChange.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the Own computer switch", () => {
  it("on a Team Computer says it is shared, in English and Turkish, and turns on", () => {
    const { toggle, line } = show("team");
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
    expect(line).toBe("Shared with this Space's other bots, files and sign-ins included.");
    expect(show("team", null, "tr").line).toBe(
      "Bu alandaki diğer botlarla ortak, dosyalar ve girişler dahil.",
    );
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith("dedicated");
  });

  it("says nothing once the bot has its own computer", () => {
    expect(show("dedicated").line).toBeNull();
  });

  it("without billing (a self-hosted server) still says the Team Computer is shared", () => {
    billing.status = null;
    expect(show("team").line).toContain("Shared with");
  });

  it("on Free is off and disabled, says why, and Upgrade opens the plans", () => {
    billing.status = free;
    const { toggle, line, button } = show("team");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => toggle.click());
    expect(line).toContain("Your plan doesn't include a computer.");
    act(() => (button as HTMLElement).click());
    expect(billing.showPlans).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("on Free, a member who cannot manage billing is told to ask the owner, with no button", () => {
    billing.status = { ...free, canManage: false };
    const { line, button } = show("team");
    expect(line).toBe("Your plan doesn't include a computer. Ask the owner to upgrade.");
    expect(button).toBeNull();
  });

  it("shows a refused switch beside it instead of the hint", () => {
    const { line } = show("team", "Computer limit reached. Archive a bot to free one.");
    expect(line).toBe("Computer limit reached. Archive a bot to free one.");
  });
});
