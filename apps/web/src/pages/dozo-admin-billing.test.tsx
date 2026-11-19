// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, Children, cloneElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), summary: vi.fn(), revenue: vi.fn() }));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: () => api.me() }) },
    dozoAdmin: {
      billing: {
        summary: {
          queryOptions: () => ({ queryKey: ["summary"], queryFn: () => api.summary() }),
        },
        revenue: {
          queryOptions: ({ input }: { input: object }) => ({
            queryKey: ["revenue", input],
            queryFn: () => api.revenue(input),
          }),
        },
      },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./NotFound", () => ({ NotFoundPage: () => <div data-testid="not-found" /> }));
vi.mock("../components/PageLoading", () => ({
  PageLoading: () => <div data-testid="page-loading" />,
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
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  type Item = ReactElement<{ value: string; pressed?: boolean; onPick?: () => void }>;
  return {
    Badge: ({ children }: { children?: ReactNode }) => <span data-badge>{children}</span>,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    buttonVariants: () => "",
    SectionHeading: Pass,
    Spinner: () => <span role="status" />,
    ToggleGroup: (props: {
      value: string[];
      onValueChange: (value: string[]) => void;
      children: ReactNode;
    }) => (
      <fieldset>
        {Children.map(props.children, (child) => {
          if (!isValidElement(child)) return child;
          const item = child as Item;
          const pressed = props.value.includes(item.props.value);
          return cloneElement(item, {
            pressed,
            onPick: () => props.onValueChange(pressed ? [] : [item.props.value]),
          });
        })}
      </fieldset>
    ),
    ToggleGroupItem: (props: { pressed?: boolean; onPick?: () => void; children: ReactNode }) => (
      <button type="button" aria-pressed={props.pressed} onClick={props.onPick}>
        {props.children}
      </button>
    ),
  };
});

import { DozoAdminBillingPage } from "./dozo-admin-billing";

const summary = {
  members: 12,
  paid: 3,
  trialing: 1,
  granted: 2,
  plans: [
    { tier: "standard", total: 7, monthly: 0, yearly: 0, granted: 0 },
    { tier: "pro", total: 4, monthly: 2, yearly: 1, granted: 1 },
    { tier: "max", total: 1, monthly: 0, yearly: 0, granted: 1 },
  ],
  ending: { within7Days: 1, within30Days: 2 },
  pastDue: 1,
  cancelling: 1,
};
const revenue = {
  totals: [
    { currency: "usd", paid: 123_456, refunded: 1_000 },
    { currency: "jpy", paid: 5_000, refunded: 0 },
  ],
  failed: 2,
  partial: false,
  payments: [
    {
      member: { id: "ada", email: "ada@example.test" },
      amount: 1_999,
      currency: "usd",
      at: "2026-11-10T00:00:00.000Z",
      status: "paid",
    },
    {
      member: null,
      amount: 700,
      currency: "bogus",
      at: "2026-11-09T00:00:00.000Z",
      status: "failed",
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <DozoAdminBillingPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const shown = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const text = (testId: string) => shown(testId)?.textContent ?? "";

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

const click = (node: HTMLElement) => act(async () => node.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.me.mockResolvedValue({ isAdmin: true, userId: "admin" });
  api.summary.mockResolvedValue(summary);
  api.revenue.mockResolvedValue(revenue);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows anyone but an admin the page an unknown address shows, and reads nothing", async () => {
  const me = deferred<{ isAdmin: boolean }>();
  api.me.mockReturnValue(me.promise);
  await render();
  expect(shown("page-loading")).toBeTruthy();
  await act(async () => me.resolve({ isAdmin: false }));
  await vi.waitFor(() => expect(shown("not-found")).toBeTruthy());
  expect(api.summary).not.toHaveBeenCalled();
  expect(api.revenue).not.toHaveBeenCalled();
});

it("shows the members, each plan and what needs attention", async () => {
  await render();
  await vi.waitFor(() => expect(shown("billing-summary")).toBeTruthy());
  expect(text("billing-summary")).toBe("12 members3 paid1 on trial2 granted");
  const plans = [...(shown("billing-plans")?.querySelectorAll("li") ?? [])];
  expect(plans.map((row) => row.textContent)).toEqual([
    "Free7",
    "Premium2 monthly1 yearly1 granted4",
    "Premium Plus1 granted1",
  ]);
  expect(text("billing-ending")).toBe("1 ending in 7 days2 in 30 days1 past due1 cancelling");
});

it("leaves out payment trouble and cancellations when there are none", async () => {
  api.summary.mockResolvedValue({ ...summary, members: 1, pastDue: 0, cancelling: 0 });
  await render();
  await vi.waitFor(() => expect(shown("billing-ending")).toBeTruthy());
  expect(text("billing-summary")).toContain("1 member");
  expect(text("billing-ending")).toBe("1 ending in 7 days2 in 30 days");
});

it("shows the period's totals in each currency and the newest payments, linked to the member", async () => {
  await render();
  await vi.waitFor(() => expect(shown("billing-payments")).toBeTruthy());
  expect(api.revenue).toHaveBeenCalledWith({ period: "thisMonth" });
  expect(text("billing-totals")).toBe("$1,234.56 paid$10.00 refunded¥5,000 paid2 failed payments");
  const [paid, failed] = [...(shown("billing-payments")?.querySelectorAll("li") ?? [])];
  expect(paid?.querySelector("a")?.getAttribute("href")).toBe("/admin/users/ada");
  expect(paid?.textContent).toBe("ada@example.testNov 10, 2026$19.99Paid");
  // An unknown currency is shown as the provider gave it.
  expect(failed?.textContent).toBe("—Nov 9, 2026700 BOGUSFailed");
});

it("reads another period when one is picked, and keeps it when it is picked again", async () => {
  await render();
  await vi.waitFor(() => expect(shown("billing-totals")).toBeTruthy());
  await click(button("Last month"));
  await vi.waitFor(() => expect(api.revenue).toHaveBeenCalledWith({ period: "lastMonth" }));
  await click(button("Last month"));
  await click(button("12 months"));
  await vi.waitFor(() => expect(api.revenue).toHaveBeenCalledWith({ period: "last12Months" }));
  expect(api.revenue).toHaveBeenCalledTimes(3);
  expect(button("12 months").getAttribute("aria-pressed")).toBe("true");
});

it("says when there were no payments and when only the newest records were read", async () => {
  api.revenue.mockResolvedValue({ totals: [], failed: 0, partial: true, payments: [] });
  await render();
  await vi.waitFor(() => expect(shown("billing-totals")).toBeTruthy());
  expect(text("billing-totals")).toBe("No paymentsNewest records only");
  expect(shown("billing-payments")).toBeNull();
});

it("hides payments without a payment provider", async () => {
  api.revenue.mockResolvedValue(null);
  await render();
  await vi.waitFor(() => expect(shown("billing-summary")).toBeTruthy());
  await vi.waitFor(() => expect(api.revenue).toHaveBeenCalled());
  await vi.waitFor(() => expect(container.textContent).not.toContain("Payments"));
});

it("shows a failed read with a way to try again", async () => {
  api.summary.mockRejectedValueOnce(new Error("Summary down"));
  api.revenue.mockRejectedValueOnce(new Error("Payments down"));
  await render();
  await vi.waitFor(() => expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2));
  expect(container.textContent).toContain("Summary down");
  expect(container.textContent).toContain("Payments down");
  for (const retry of container.querySelectorAll<HTMLElement>('[role="alert"] button'))
    await click(retry);
  await vi.waitFor(() => expect(shown("billing-payments")).toBeTruthy());
  expect(shown("billing-summary")).toBeTruthy();
});

it("shows a spinner while each part loads", async () => {
  const pending = deferred<typeof summary>();
  api.summary.mockReturnValue(pending.promise);
  api.revenue.mockReturnValue(deferred().promise);
  await render();
  await vi.waitFor(() => expect(container.querySelectorAll('[role="status"]')).toHaveLength(2));
  await act(async () => pending.resolve(summary));
  await vi.waitFor(() => expect(shown("billing-summary")).toBeTruthy());
});
