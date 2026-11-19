// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { DozoCacheSavings as Savings } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the procedure joins the app contract through a brand rule.

// The macro is not compiled in tests: a descriptor goes to the real catalog, so the fork's
// Turkish is what is checked.
vi.mock("@lingui/react/macro", async () => {
  const { i18n: real } = await import("@lingui/core");
  return {
    useLingui: () => ({
      t: (descriptor: { id: string; message: string }) => real._(descriptor),
      i18n: real,
    }),
  };
});
const answer = vi.hoisted(() => ({ value: null as Savings | null }));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    dozoUsage: {
      cacheSavings: {
        queryOptions: () => ({ queryKey: ["cacheSavings"], queryFn: async () => answer.value }),
      },
    },
  }),
}));
vi.mock("./PlanUsage", () => ({ PlanUsage: () => <div data-testid="upstream-plan-usage" /> }));

import { DozoCacheSavings } from "./dozo-cache-savings";
import { PlanUsage } from "./dozo-plan-usage";

const savings: Savings = {
  since: "2026-11-01T00:00:00.000Z",
  inputTokens: 1_700_000,
  cacheReadTokens: 1_224_000,
  cacheReadPercent: 72,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  answer.value = savings;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Renders `node` and waits until the answer has arrived and the share is on the page. */
async function show(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await vi.waitFor(() => expect(client.getQueryState(["cacheSavings"])?.status).toBe("success"));
  if (answer.value) await vi.waitFor(() => expect(host.querySelector("button")).not.toBeNull());
  else await act(async () => undefined);
}

it("renders nothing without input this period", async () => {
  answer.value = null;
  await show(<DozoCacheSavings />);
  expect(host.innerHTML).toBe("");
});

it("shows the share, and the two counts when pressed", async () => {
  await show(<DozoCacheSavings />);
  const trigger = host.querySelector("button");
  expect(trigger?.textContent).toBe("Cached input72%");
  expect(document.body.textContent).not.toContain("Total input");
  await act(async () => trigger?.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Read from cache1,224,000"));
  expect(document.body.textContent).toContain("Total input1,700,000");
});

it("speaks Turkish", async () => {
  i18n.load("tr", {});
  i18n.activate("tr");
  await show(<DozoCacheSavings />);
  const trigger = host.querySelector("button");
  expect(trigger?.textContent).toBe("Önbellekten girdi%72");
  await act(async () => trigger?.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Önbellekten okunan"));
  expect(document.body.textContent).toContain("Toplam girdi");
});

it("sits under upstream's allowances in Settings > Usage", async () => {
  await show(<PlanUsage />);
  expect(host.firstElementChild?.getAttribute("data-testid")).toBe("upstream-plan-usage");
  expect(host.querySelector("[data-testid=cache-savings]")).not.toBeNull();
});
