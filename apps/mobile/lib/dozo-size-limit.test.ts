import { beforeEach, describe, expect, it, vi } from "vitest";

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert } }));

import { showSizeNotInPlan } from "./dozo-size-limit";

type Button = { text: string; onPress?: () => void };
const buttons = (): Button[] => alert.mock.calls[0]?.[2] ?? [];

describe("the size the plan does not include", () => {
  beforeEach(() => alert.mockClear());

  it("off: Cancel and an Upgrade that opens Billing", () => {
    const openBilling = vi.fn();
    showSizeNotInPlan(openBilling, false);
    expect(alert.mock.calls[0]?.[0]).toBe("Your plan does not include this size.");
    expect(buttons().map((button) => button.text)).toEqual(["Cancel", "Upgrade"]);
    buttons()[1]?.onPress?.();
    expect(openBilling).toHaveBeenCalledOnce();
  });

  it("on: names the limit and offers only Close, with no way to Billing", () => {
    const openBilling = vi.fn();
    showSizeNotInPlan(openBilling, true);
    expect(alert.mock.calls[0]?.[0]).toBe("Your plan does not include this size.");
    expect(buttons().map((button) => button.text)).toEqual(["Close"]);
    expect(buttons().every((button) => button.onPress === undefined)).toBe(true);
    expect(openBilling).not.toHaveBeenCalled();
  });
});
