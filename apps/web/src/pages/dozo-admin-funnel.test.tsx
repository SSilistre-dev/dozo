// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ComponentType, ReactElement, ReactNode } from "react";
import { act, Children, cloneElement, isValidElement, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    dozoAdmin: {
      funnel: {
        read: {
          queryOptions: ({ input }: { input: object }) => ({
            queryKey: ["funnel", input],
            queryFn: () => api.read(input),
          }),
        },
      },
    },
  }),
}));
vi.mock("../lib/dozo-error-text", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
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

import { DozoAdminFunnel } from "./dozo-admin-funnel";
import { DOZO_ADMIN_NAV } from "./dozo-admin-nav";

const hour = 3600;
const funnel = {
  days: 30,
  steps: [
    { step: "signedUp", members: 40, rate: null, medianSeconds: null },
    { step: "modelConnected", members: 20, rate: 50, medianSeconds: 600 },
    { step: "firstBot", members: 10, rate: 50, medianSeconds: 3 * hour },
    { step: "firstMessage", members: 9, rate: 90, medianSeconds: 3 * 24 * hour },
    { step: "paid", members: 0, rate: 0, medianSeconds: null },
  ],
  granted: 2,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(Page: ComponentType = DozoAdminFunnel) {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </QueryClientProvider>,
    );
  });
}

const shown = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

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
  api.read.mockReset();
  api.read.mockResolvedValue(funnel);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("is the admin page's funnel section, loaded when it opens", async () => {
  const section = DOZO_ADMIN_NAV.find((entry) => entry.path === "funnel");
  expect(section?.page).toBeTruthy();
  await render(section?.page);
  await vi.waitFor(() => expect(shown("funnel")).toBeTruthy());
});

it("shows one row per step: its count, its share of the step before and its median wait", async () => {
  await render();
  await vi.waitFor(() => expect(shown("funnel")).toBeTruthy());
  const rows = [...(shown("funnel")?.querySelectorAll("li") ?? [])];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "Signed up",
    "Connected a model",
    "Created a bot",
    "Sent a message",
    "Paid",
  ]);
  expect(rows.map((row) => row.textContent)).toEqual([
    "Signed up40",
    "Connected a model2050%10 min",
    "Created a bot1050%3 h",
    "Sent a message990%3 d",
    "Paid00%",
  ]);
  // Bars are drawn against the sign-ups.
  const widths = [...container.querySelectorAll<HTMLElement>('[data-testid="funnel-bar"]')].map(
    (bar) => bar.style.width,
  );
  expect(widths).toEqual(["100%", "50%", "25%", "22.5%", "0%"]);
  expect(shown("funnel-granted")?.textContent).toBe("2 on a granted plan, not counted as paid");
});

it("reads the period picked, from 30 days by default", async () => {
  await render();
  await vi.waitFor(() => expect(api.read).toHaveBeenCalledWith({ days: 30 }));
  expect(button("30 days").getAttribute("aria-pressed")).toBe("true");
  await click(button("7 days"));
  await vi.waitFor(() => expect(api.read).toHaveBeenCalledWith({ days: 7 }));
  // Picking the open period again keeps it.
  await click(button("7 days"));
  await click(button("90 days"));
  await vi.waitFor(() => expect(api.read).toHaveBeenCalledWith({ days: 90 }));
  expect(api.read).toHaveBeenCalledTimes(3);
  expect(button("90 days").getAttribute("aria-pressed")).toBe("true");
});

it("says so in one line when nobody signed up, and leaves out granted plans when none", async () => {
  api.read.mockResolvedValue({
    ...funnel,
    steps: funnel.steps.map((row) => ({ ...row, members: 0, rate: null, medianSeconds: null })),
    granted: 0,
  });
  await render();
  await vi.waitFor(() => expect(shown("funnel-empty")).toBeTruthy());
  expect(shown("funnel-empty")?.textContent).toBe("No sign-ups in this period");
  expect(shown("funnel")).toBeNull();

  api.read.mockResolvedValue({ ...funnel, granted: 0 });
  await click(button("7 days"));
  await vi.waitFor(() => expect(shown("funnel")).toBeTruthy());
  expect(shown("funnel-granted")).toBeNull();
});

it("shows a failed read with a way to try again, and a spinner while it loads", async () => {
  api.read.mockRejectedValueOnce(new Error("Funnel down"));
  const pending = deferred<typeof funnel>();
  api.read.mockReturnValueOnce(pending.promise);
  await render();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeTruthy());
  expect(container.textContent).toContain("Funnel down");
  await click(button("Retry"));
  await act(async () => pending.resolve(funnel));
  await vi.waitFor(() => expect(shown("funnel")).toBeTruthy());

  await act(async () => root.unmount());
  root = createRoot(container);
  api.read.mockReturnValue(deferred().promise);
  await render();
  expect(container.querySelector('[role="status"]')).toBeTruthy();
});
