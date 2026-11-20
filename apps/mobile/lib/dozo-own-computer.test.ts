import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmComputerMove, useOwnComputerSwitch } from "./dozo-own-computer";

// Runs on the branded tree: Free has no computer once the plans are laid over the tiers, and the
// Turkish catalog carries the fork's lines.

const native = vi.hoisted(() => ({
  billing: undefined as Partial<BillingStatus> | undefined,
  alert: vi.fn(),
}));
vi.mock("./query", () => ({ rpcQuery: (proc: string) => ({ queryKey: [proc] }) }));
vi.mock("react-native", () => ({ Alert: { alert: native.alert } }));
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
  native.alert.mockReset();
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

describe("switching computers on mobile", () => {
  type Button = { text: string; style?: string; onPress?: () => void };
  const asked = () => native.alert.mock.calls[0] as [string, undefined, Button[]];

  it("asks first, says what moves, and switches only on Move", () => {
    const apply = vi.fn();
    confirmComputerMove("dedicated", apply);
    expect(asked()[0]).toBe(
      "This bot's files and browser sign-ins move to its own computer and are removed from the Team Computer.",
    );
    expect(apply).not.toHaveBeenCalled();
    asked()[2]
      .find((button) => button.text === "Move")
      ?.onPress?.();
    expect(apply).toHaveBeenCalledWith("dedicated");
  });

  it("says in Turkish that the Team Computer is open to the other bots", () => {
    i18n.activate("tr");
    confirmComputerMove("team", vi.fn());
    expect(asked()[0]).toBe(
      "Bu botun dosyaları ve tarayıcı girişleri Takım Bilgisayarına taşınır; bu alandaki diğer botlar onları açabilir.",
    );
    expect(asked()[2].map((button) => button.text)).toEqual(["İptal", "Taşı"]);
  });
});
