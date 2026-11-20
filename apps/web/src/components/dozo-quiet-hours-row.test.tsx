// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoQuietHours: { set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoQuietHours: {
      get: {
        key: () => ["quiet"],
        queryOptions: () => ({ queryKey: ["quiet"], queryFn: () => api.get() }),
      },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ htmlFor, children, className }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
  toast: { error: api.toastError },
}));

import type * as Query from "../lib/query";
import { DOZO_DEFAULT_QUIET_HOURS, DozoQuietHoursRow } from "./dozo-quiet-hours-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoQuietHoursRow />
      </QueryClientProvider>,
    );
  });
}

const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const select = (label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

async function loaded() {
  await render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
}

async function choose(label: string, value: string) {
  const node = select(label);
  if (!node) throw new Error(`Missing ${label}`);
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.set.mockImplementation(async ({ hours }) => {
    api.get.mockResolvedValue({ hours });
    return { hours };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only its switch while off, named by its label", async () => {
  api.get.mockResolvedValue({ hours: null });
  await loaded();
  expect(toggle()?.checked).toBe(false);
  expect(container.querySelector(`label[for="${toggle()?.id}"]`)?.textContent).toBe("Quiet hours");
  expect(container.querySelectorAll("select")).toHaveLength(0);
});

it("turns on for the night, then shows when they start and end", async () => {
  api.get.mockResolvedValue({ hours: null });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ hours: DOZO_DEFAULT_QUIET_HOURS });
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  expect(select("Quiet hours start")?.value).toBe("1320");
  expect(select("Quiet hours end")?.value).toBe("420");
  expect(select("Quiet hours start")?.selectedOptions[0]?.textContent).toBe("22:00");
  // The end cannot be where it starts.
  expect(
    select("Quiet hours end")?.querySelector<HTMLOptionElement>('option[value="1320"]')?.disabled,
  ).toBe(true);
});

it("changes one edge and keeps the other", async () => {
  api.get.mockResolvedValue({ hours: DOZO_DEFAULT_QUIET_HOURS });
  await loaded();
  await choose("Quiet hours end", "480");
  expect(api.set).toHaveBeenCalledWith({ hours: { startMinute: 1320, endMinute: 480 } });
  await vi.waitFor(() => expect(select("Quiet hours end")?.value).toBe("480"));
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  await choose("Quiet hours start", "1380");
  expect(api.set).toHaveBeenLastCalledWith({ hours: { startMinute: 1380, endMinute: 480 } });
});

it("keeps a start set off the hour among the choices", async () => {
  api.get.mockResolvedValue({ hours: { startMinute: 22 * 60 + 30, endMinute: 6 * 60 } });
  await loaded();
  expect(select("Quiet hours start")?.value).toBe("1350");
  expect(select("Quiet hours start")?.options).toHaveLength(25);
});

it("turns off", async () => {
  api.get.mockResolvedValue({ hours: DOZO_DEFAULT_QUIET_HOURS });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ hours: null });
  await vi.waitFor(() => expect(container.querySelectorAll("select")).toHaveLength(0));
});

it("says so when the save fails, and shows the saved hours again", async () => {
  api.get.mockResolvedValue({ hours: null });
  api.set.mockRejectedValue(new Error("down"));
  await loaded();
  await act(async () => toggle()?.click());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Couldn't update quiet hours"),
  );
  await vi.waitFor(() => expect(toggle()?.checked).toBe(false));
});

it("stays off and still while the saved hours cannot be read", async () => {
  api.get.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(toggle()?.disabled).toBe(true);
});
