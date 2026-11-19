// @vitest-environment jsdom
import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: Free has no computer once the plans are laid over the tiers, and
// the Turkish catalog carries the fork's lines.

const billing = vi.hoisted(() => ({ status: null as Partial<BillingStatus> | null }));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => undefined }),
}));

import { errorText } from "../../lib/user-error";
import { useComputerAllowance } from "./dozo-computer-allowance";

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
/** A Free organization's owner, as the billing status reads before any model is connected. */
const free: Partial<BillingStatus> = {
  canManage: true,
  byokTier: "standard",
  byokTiers: offers,
  funding: null,
  state: "none",
};

/** What the server answers a Free computer start, as the RPC client throws it. */
const refused = Object.assign(new Error("No computer hours left."), {
  status: 403,
  code: "FORBIDDEN",
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let shown: ReturnType<typeof useComputerAllowance> | null;

function Probe({ failure, running }: { failure: string | null; running: boolean }) {
  shown = useComputerAllowance(failure, running);
  return null;
}

function read(failure: string | null, running = false) {
  act(() => root.render(<Probe failure={failure} running={running} />));
  return shown;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load({ en: {}, tr: tr as Messages });
  i18n.activate("tr");
  billing.status = free;
  shown = null;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("Free: a refused start says the plan has no computer and offers Upgrade, in Turkish", () => {
  // The boot failure reaches the screen through errorText, which keeps the hours refusal.
  const failure = errorText(refused, "Computer failed to boot");
  expect(failure).toBe("No computer hours left.");
  expect(read(failure)).toEqual({
    allowanceUsed: true,
    text: "Planınızda bilgisayar yok.",
    upgrade: "Yükselt",
  });
});

it("Free, a member who cannot manage billing: ask the owner, no button", () => {
  billing.status = { ...free, canManage: false };
  expect(read("No computer hours left.")).toEqual({
    allowanceUsed: true,
    text: "Planınızda bilgisayar yok. Yükseltmesi için sahibine sorun.",
    upgrade: null,
  });
});

it("never shows the server's words: no billing status, a trial", () => {
  billing.status = null;
  expect(read("No computer hours left.")?.text).toBe("Bilgisayar saatiniz kalmadı.");
  billing.status = { ...free, state: "trialing" };
  expect(read("No computer hours left.")).toEqual({
    allowanceUsed: true,
    text: "Bilgisayar saatiniz kalmadı.",
    upgrade: "Yükselt",
  });
});

it("leaves any other failure, and a running computer, as they are", () => {
  expect(read("Could not connect")).toEqual({
    allowanceUsed: false,
    text: "Could not connect",
    upgrade: null,
  });
  expect(read("No computer hours left.", true)?.allowanceUsed).toBe(false);
  expect(read(null)?.text).toBeNull();
});
