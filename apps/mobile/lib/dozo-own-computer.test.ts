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
  me: { userId: "maker" } as { userId: string } | undefined,
  members: undefined as { canManage: boolean } | undefined,
}));
vi.mock("./query", () => ({ rpcQuery: (proc: string) => ({ queryKey: [proc] }) }));
vi.mock("react-native", () => ({ Alert: { alert: native.alert } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => ({
    data:
      enabled === false
        ? undefined
        : {
            "billing/status": native.billing,
            me: native.me,
            "spaces/members/list": native.members,
          }[queryKey[0] as string],
  }),
}));

const mine = { spaceId: "space", userId: "maker" };

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
  native.me = { userId: "maker" };
  native.members = undefined;
});

describe("the mobile Own computer switch", () => {
  it("says a Team Computer is shared, in Turkish too, and stays usable", () => {
    expect(useOwnComputerSwitch("team", mine)).toEqual({
      detail: "Shared with this Space's other bots, files and sign-ins included.",
      disabled: false,
    });
    i18n.activate("tr");
    expect(useOwnComputerSwitch("team", mine).detail).toBe(
      "Bu alandaki diğer botlarla ortak, dosyalar ve girişler dahil.",
    );
  });

  it("says nothing once the bot has its own computer", () => {
    expect(useOwnComputerSwitch("dedicated", mine)).toEqual({ detail: undefined, disabled: false });
  });

  it("before the plan is read, or with no billing, still says it is shared", () => {
    native.billing = undefined;
    expect(useOwnComputerSwitch("team", mine).disabled).toBe(false);
  });

  it("on Free is disabled and says the plan has no computer", () => {
    native.billing = free;
    expect(useOwnComputerSwitch("team", mine)).toEqual({
      detail: "Your plan doesn't include a computer.",
      disabled: true,
    });
    native.billing = { ...free, canManage: false };
    expect(useOwnComputerSwitch("team", mine).detail).toBe(
      "Your plan doesn't include a computer. Ask the owner to upgrade.",
    );
  });
});

describe("a member who did not make the bot", () => {
  const theirs = { spaceId: "space", userId: "someone-else" };

  it("sees the switch read-only, with the reason, unless they own the Space", () => {
    expect(useOwnComputerSwitch("team", theirs)).toEqual({
      detail: "Only the space owner can do that",
      disabled: true,
    });
    i18n.activate("tr");
    expect(useOwnComputerSwitch("team", theirs).detail).toBe(
      "Bunu yalnızca alanın sahibi yapabilir",
    );
    native.members = { canManage: true };
    expect(useOwnComputerSwitch("team", theirs).disabled).toBe(false);
  });

  it("is not held back before the bot or the account is known", () => {
    expect(useOwnComputerSwitch("team", null).disabled).toBe(false);
    native.me = undefined;
    expect(useOwnComputerSwitch("team", theirs).disabled).toBe(false);
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
