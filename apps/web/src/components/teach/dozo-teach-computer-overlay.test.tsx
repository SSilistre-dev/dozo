// @vitest-environment jsdom

import type { BillingStatus } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ billing: null as Partial<BillingStatus> | null }));

vi.mock("../SubscriptionGate", () => ({ useBilling: () => ({ status: api.billing }) }));
vi.mock("./TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: ({ botId }: { botId: string }) => (
    <button type="button">teach {botId}</button>
  ),
}));

import { TeachComputerOverlayControl } from "./dozo-teach-computer-overlay";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () =>
    root.render(
      <TeachComputerOverlayControl
        botId="bot-1"
        computer={null}
        onRefresh={async () => undefined}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows upstream's control where the deployment does not bill", async () => {
  api.billing = null;
  await render();
  expect(container.textContent).toBe("teach bot-1");
});

it("shows upstream's control on a plan with a computer, a trial or credits", async () => {
  for (const billing of [
    { state: "active", funding: "byok", byokTier: "pro" },
    { state: "trialing", funding: "byok", byokTier: "standard" },
    { state: "active", funding: "credits", byokTier: "standard" },
  ] as const) {
    api.billing = billing;
    await render();
    expect(container.textContent).toBe("teach bot-1");
  }
});

it("hides it on a plan with no computer", async () => {
  for (const billing of [
    { state: "active", funding: "byok", byokTier: "standard" },
    { state: "none", funding: null },
  ] as const) {
    api.billing = billing;
    await render();
    expect(container.textContent).toBe("");
  }
});
