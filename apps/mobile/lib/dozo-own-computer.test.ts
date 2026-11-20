import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOwnComputerSwitch } from "./dozo-own-computer";

// Runs on the branded tree: Free has no computer once the plans are laid over the tiers, and the
// Turkish catalog carries the fork's lines.

const native = vi.hoisted(() => ({ billing: undefined as Partial<BillingStatus> | undefined }));
vi.mock("./query", () => ({ rpcQuery: (proc: string) => ({ queryKey: [proc] }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: native.billing }) }));

const free: Partial<BillingStatus> = {
  canManage: true,
  byokTier: "standard",
  byokTiers: [],
  funding: null,
  state: "none",
};

beforeEach(() => {
  i18n.load({ en: {}, tr: tr as Messages });
  i18n.activate("en");
  native.billing = { ...free, byokTier: "pro", state: "active" };
});

describe("the mobile Own computer switch", () => {
  it("says a Team Computer is shared, in Turkish too, and stays usable", () => {
    expect(useOwnComputerSwitch("team")).toEqual({
      detail: "Shared with this Space's other bots, files and sign-ins included.",
      disabled: false,
    });
    i18n.activate("tr");
    expect(useOwnComputerSwitch("team").detail).toBe(
      "Bu alandaki diğer botlarla ortak, dosyalar ve girişler dahil.",
    );
  });

  it("says nothing once the bot has its own computer", () => {
    expect(useOwnComputerSwitch("dedicated")).toEqual({ detail: undefined, disabled: false });
  });

  it("before the plan is read, or with no billing, still says it is shared", () => {
    native.billing = undefined;
    expect(useOwnComputerSwitch("team").disabled).toBe(false);
  });

  it("on Free is disabled and says the plan has no computer", () => {
    native.billing = free;
    expect(useOwnComputerSwitch("team")).toEqual({
      detail: "Your plan doesn't include a computer.",
      disabled: true,
    });
    native.billing = { ...free, canManage: false };
    expect(useOwnComputerSwitch("team").detail).toBe(
      "Your plan doesn't include a computer. Ask the owner to upgrade.",
    );
  });
});
