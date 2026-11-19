// @vitest-environment jsdom
import type { DozoAdminPlanRow } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), setQuota: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoAdmin: { plans: { setQuota: api.setQuota } } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoAdmin: {
      plans: {
        list: {
          key: () => ["plans"],
          queryOptions: () => ({ queryKey: ["plans"], queryFn: () => api.list() }),
        },
      },
    },
  }),
}));
vi.mock("../lib/dozo-error-text", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Disclosure: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => (
    <details>
      <summary>{summary}</summary>
      {children}
    </details>
  ),
  Spinner: () => <span role="status" />,
}));

import type * as Query from "../lib/query";
import { DOZO_ADMIN_NAV } from "./dozo-admin-nav";
import { DozoAdminPlans } from "./dozo-admin-plans";

const quota = (value: number | null, set = false) => ({ value, terms: value, set });
const free: DozoAdminPlanRow = {
  tier: "standard",
  name: "Free",
  monthlyPriceCents: null,
  annualPriceCents: null,
  currency: "usd",
  priceKeys: { month: null, year: null },
  computer: null,
  sharedSpaceMb: quota(500),
  computerHours: quota(0),
  computerHoursEditable: false,
  members: 7,
};
const premium: DozoAdminPlanRow = {
  tier: "pro",
  name: "Premium",
  monthlyPriceCents: 4900,
  annualPriceCents: 46800,
  currency: "usd",
  priceKeys: { month: "key_pro_monthly", year: "key_pro_yearly" },
  computer: { vcpus: 2, memoryGb: 4 },
  sharedSpaceMb: quota(2048),
  computerHours: quota(100),
  computerHoursEditable: true,
  members: 1,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(Page: ComponentType = DozoAdminPlans) {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const plan = (tier: string) => container.querySelector(`[data-testid="plan-${tier}"]`);
const labelled = (label: string) =>
  container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

async function open() {
  await render();
  await vi.waitFor(() => expect(plan("pro")).toBeTruthy());
}

async function type(label: string, value: string) {
  const input = labelled(label);
  if (!input) throw new Error(`Missing ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.list.mockResolvedValue({ plans: [free, premium] });
  api.setQuota.mockResolvedValue({ plans: [free, premium] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("is the admin page's Plans section, loaded when it opens", async () => {
  const section = DOZO_ADMIN_NAV.find((candidate) => candidate.path === "plans");
  if (!section?.page) throw new Error("The plans section has no page");
  await render(section.page);
  await vi.waitFor(() => expect(plan("pro")).toBeTruthy());
});

it("shows each plan's price, keys, machine and members, and Free without a computer", async () => {
  await open();
  const text = plan("pro")?.textContent ?? "";
  expect(text).toContain("$49 / month");
  expect(text).toContain("$468 / year");
  expect(text).not.toContain("·");
  // The internal keys sit behind a fold, one per line, under "Price keys".
  const keys = plan("pro")?.querySelector("details");
  expect(keys?.querySelector("summary")?.textContent).toBe("Price keys");
  expect([...(keys?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
    "key_pro_monthly",
    "key_pro_yearly",
  ]);
  expect(text).toContain("key_pro_monthly");
  expect(text).toContain("key_pro_yearly");
  expect(text).toContain("2 vCPU");
  expect(text).toContain("4 GB RAM");
  expect(text).toContain("1 member");
  const freeText = plan("standard")?.textContent ?? "";
  expect(freeText).toContain("Free");
  expect(freeText).toContain("7 members");
  expect(freeText).not.toContain("vCPU");
  expect(labelled("Computer hours a month for Free")).toBeNull();
  expect(labelled("Shared space in MB for Free")?.placeholder).toBe("500");
  // Nothing edited, nothing to save, nothing differs from the landing page.
  expect(button("Save")).toBeUndefined();
  expect(container.textContent).not.toContain("Landing says");
});

it("saves only the quota that was edited", async () => {
  await open();
  await type("Computer hours a month for Premium", "120");
  await act(async () => button("Save")?.click());
  expect(api.setQuota).toHaveBeenCalledWith({ tier: "pro", computerHours: 120 });
});

it("returns an emptied quota to the plan's terms", async () => {
  api.list.mockResolvedValue({
    plans: [free, { ...premium, sharedSpaceMb: { value: 3072, terms: 2048, set: true } }],
  });
  await open();
  expect(labelled("Shared space in MB for Premium")?.value).toBe("3072");
  await type("Shared space in MB for Premium", "");
  await act(async () => button("Save")?.click());
  expect(api.setQuota).toHaveBeenCalledWith({ tier: "pro", sharedSpaceMb: null });
});

it("says in one line what the landing page says when a quota differs from it", async () => {
  api.list.mockResolvedValue({
    plans: [
      { ...free, sharedSpaceMb: { value: 100, terms: 500, set: true } },
      { ...premium, computerHours: { value: 50, terms: 100, set: true } },
    ],
  });
  await open();
  expect(plan("standard")?.textContent).toContain("Landing says 500 MB");
  expect(plan("pro")?.textContent).toContain("Landing says 100 hours");
});

it("tells a failed save and a failed load", async () => {
  api.setQuota.mockRejectedValue(new Error("nope"));
  await open();
  await type("Shared space in MB for Free", "10");
  await act(async () => button("Save")?.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalled());
  api.list.mockRejectedValue(new Error("Down"));
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Down"));
});
