// @vitest-environment jsdom
import type { BillingStatus } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({ status: null as Partial<BillingStatus> | null }));
vi.mock("./SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => undefined }),
}));

import { DozoSelfHostOnly } from "./dozo-self-host-only";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const show = () =>
  act(() =>
    root.render(
      <DozoSelfHostOnly>
        <a href="https://example.com/self-host">Docs</a>
      </DozoSelfHostOnly>,
    ),
  );

it("a self-hosted deployment, which does not bill, keeps the self-host docs", () => {
  billing.status = null;
  show();
  expect(host.textContent).toBe("Docs");
});

it("the hosted service, which bills, leaves them out", () => {
  billing.status = { state: "none", canManage: true };
  show();
  expect(host.textContent).toBe("");
});
