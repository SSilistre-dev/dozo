// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/query/rpc", () => {
  const rpc = { dozoSendLimit: { set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoSendLimit: {
      get: {
        key: () => ["sends"],
        queryOptions: () => ({ queryKey: ["sends"], queryFn: () => api.get() }),
      },
    },
  }),
}));
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ htmlFor, children, className }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
  OptionSelect: ({
    options,
    value,
    onValueChange,
    size: _size,
    "data-testid": testId,
    ...props
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    value: string | null;
    onValueChange: (value: string) => void;
    size?: string;
    "data-testid"?: string;
  } & Omit<ComponentProps<"select">, "value" | "onChange" | "size">) => (
    <select
      data-testid={testId}
      {...props}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import type * as Query from "../lib/query/query";
import { DozoSendLimitRow } from "./dozo-send-limit-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const select = () => container.querySelector<HTMLSelectElement>("select");
const options = () => [...(select()?.options ?? [])].map((option) => option.value);

async function loaded() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoSendLimitRow />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(select()?.disabled).toBe(false));
}

async function choose(value: string) {
  await act(async () => {
    const node = select()!;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.set.mockImplementation(async ({ dailySends }) => {
    api.get.mockResolvedValue({ dailySends });
    return { dailySends };
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

it("shows the account's number, named by its label", async () => {
  api.get.mockResolvedValue({ dailySends: 50 });
  await loaded();
  expect(select()?.value).toBe("50");
  expect(options()).toEqual(["10", "25", "50", "100", "250"]);
  expect(container.querySelector(`label[for="${select()?.id}"]`)?.textContent).toBe(
    "Daily sends per bot",
  );
});

it("saves another number", async () => {
  api.get.mockResolvedValue({ dailySends: 50 });
  await loaded();
  await choose("10");
  expect(api.set).toHaveBeenCalledWith({ dailySends: 10 });
  await vi.waitFor(() => expect(select()?.value).toBe("10"));
});

it("keeps a saved number that is not among the choices", async () => {
  api.get.mockResolvedValue({ dailySends: 7 });
  await loaded();
  expect(select()?.value).toBe("7");
  expect(options()).toEqual(["7", "10", "25", "50", "100", "250"]);
});

it("says so when the save fails, and shows the saved number again", async () => {
  api.get.mockResolvedValue({ dailySends: 50 });
  api.set.mockRejectedValue(new Error("down"));
  await loaded();
  await choose("10");
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Couldn't update daily sends", expect.any(Error)),
  );
  await vi.waitFor(() => expect(select()?.value).toBe("50"));
});

it("stays still while the number cannot be read", async () => {
  api.get.mockRejectedValue(new Error("down"));
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoSendLimitRow />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(select()?.disabled).toBe(true);
});
