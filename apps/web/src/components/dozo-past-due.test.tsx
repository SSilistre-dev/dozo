// @vitest-environment jsdom
import type { BillingStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: null as Partial<BillingStatus> | null,
  portal: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("./SubscriptionGate", () => ({ useBilling: () => ({ status: api.status }) }));
vi.mock("../lib/rpc", () => ({ rpc: { billing: { portal: api.portal } } }));
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { DozoPastDue } from "./dozo-past-due";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const pastDue = { state: "past_due", canManage: true, hasCustomer: true } as const;

async function render() {
  await act(async () => root.render(<DozoPastDue />));
}
const line = () => container.querySelector('[role="status"]');
const button = () => container.querySelector("button");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.status = null;
  api.portal.mockReset();
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DozoPastDue", () => {
  it("shows one line and the way to fix it while a payment is past due", async () => {
    api.status = pastDue;
    await render();
    expect(line()?.textContent).toBe("Your last payment didn't go through.Manage billing");
  });

  it.each([
    ["without billing", null],
    ["once paid", { ...pastDue, state: "active" }],
    ["to a member who does not manage billing", { ...pastDue, canManage: false }],
  ] as const)("shows nothing %s", async (_case, status) => {
    api.status = status;
    await render();
    expect(line()).toBeNull();
  });

  it("opens the billing portal", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    api.status = pastDue;
    api.portal.mockResolvedValue({ url: "https://billing.example.com/session" });
    await render();
    await act(async () => button()?.click());
    expect(assign).toHaveBeenCalledWith("https://billing.example.com/session");
    expect(button()?.disabled).toBe(false);
  });

  it("says so when the portal does not open", async () => {
    api.status = pastDue;
    const error = new Error("down");
    api.portal.mockRejectedValue(error);
    await render();
    await act(async () => button()?.click());
    expect(api.toastError).toHaveBeenCalledWith("Could not open billing", error);
    expect(button()?.disabled).toBe(false);
  });
});
