// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: undefined as { billingEnabled: boolean } | undefined,
  status: undefined as Record<string, unknown> | undefined,
  enabled: [] as boolean[],
  rpc: vi.fn(),
  openBillingPage: vi.fn(),
  setQueryData: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: api.alert },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div role="status">{children}</div>,
}));
vi.mock("./api", () => ({ rpc: api.rpc }));
vi.mock("./billing", () => ({ openBillingPage: api.openBillingPage }));
vi.mock("./native", () => ({ useMobileTokens: () => ({ warning: "warning", border: "border" }) }));
vi.mock("./query", () => ({
  queryClient: { setQueryData: api.setQueryData },
  rpcQuery: (proc: string) => ({ queryKey: [proc] }),
}));
vi.mock("./screen-query", () => ({
  useScreenQuery: (read: { queryKey: string[] }, options?: { enabled?: boolean }) => {
    if (read.queryKey[0] === "me") return { data: api.me };
    api.enabled.push(options?.enabled ?? true);
    return { data: options?.enabled ? api.status : undefined };
  },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

import { DozoPastDueLine } from "../components/dozo-past-due-line";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const pastDue = { state: "past_due", canManage: true, hasCustomer: true };

async function render() {
  await act(async () => root.render(<DozoPastDueLine />));
}
const line = () => container.querySelector('[role="status"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.me = { billingEnabled: true };
  api.status = pastDue;
  api.enabled = [];
  for (const mock of [api.rpc, api.openBillingPage, api.setQueryData, api.alert]) mock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DozoPastDueLine", () => {
  it("shows one line and the way to fix it while a payment is past due", async () => {
    await render();
    expect(line()?.textContent).toBe("Your last payment didn't go through.Manage billing");
  });

  it("does not ask for billing on a server that does not bill", async () => {
    api.me = { billingEnabled: false };
    await render();
    expect(api.enabled).toEqual([false]);
    expect(line()).toBeNull();
  });

  it.each([
    ["once paid", { ...pastDue, state: "active" }],
    ["to a member who does not manage billing", { ...pastDue, canManage: false }],
  ])("shows nothing %s", async (_case, status) => {
    api.status = status;
    await render();
    expect(line()).toBeNull();
  });

  it("opens the billing portal and shows what it left", async () => {
    const after = { ...pastDue, state: "active" };
    api.rpc.mockResolvedValue({ url: "https://billing.example.com/session" });
    api.openBillingPage.mockResolvedValue(after);
    await render();
    await act(async () => container.querySelector("button")?.click());
    expect(api.rpc).toHaveBeenCalledWith("billing/portal", { client: "mobile" });
    expect(api.openBillingPage).toHaveBeenCalledWith("https://billing.example.com/session");
    expect(api.setQueryData).toHaveBeenCalledWith(["billing/status"], after);
  });

  it("says so when the portal does not open", async () => {
    api.rpc.mockRejectedValue(new Error("down"));
    await render();
    await act(async () => container.querySelector("button")?.click());
    expect(api.alert).toHaveBeenCalledWith("Could not open billing");
  });
});
