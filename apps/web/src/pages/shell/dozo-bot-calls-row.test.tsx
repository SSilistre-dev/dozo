// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), toastError: vi.fn() }));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { dozoBotCalls: { get: api.get, set: api.set } };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
  }),
}));
vi.mock("./bots/bot-settings-sections", () => ({
  SwitchRow: ({
    label,
    checked,
    disabled,
    onChange,
  }: {
    label: ReactNode;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
  }) => (
    <label>
      {label}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  ),
}));

import { QueryUserProvider } from "../../lib/query/query";
import { DozoBotCallsRow } from "./dozo-bot-calls-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <DozoBotCallsRow botId="bot-1" />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockReset().mockResolvedValue({ allowed: false, available: true });
  api.set.mockReset().mockImplementation(async ({ allowed }) => ({ allowed, available: true }));
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DozoBotCallsRow", () => {
  it("shows the switch off and turns it on", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Can call me"));
    const box = container.querySelector<HTMLInputElement>("input")!;
    expect(box.checked).toBe(false);
    await act(async () => box.click());
    expect(api.set).toHaveBeenCalledWith({ botId: "bot-1", allowed: true });
  });

  it("shows nothing where calls are not available", async () => {
    api.get.mockResolvedValue({ allowed: false, available: false });
    await render();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says so when the save fails", async () => {
    api.set.mockRejectedValue(new Error("no"));
    await render();
    await vi.waitFor(() => expect(container.querySelector("input")).not.toBeNull());
    await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalled());
  });
});
