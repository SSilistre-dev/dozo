// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/query/rpc", () => {
  const rpc = { dozoCommandRules: { setHostedAsks: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoCommandRules: {
      getHostedAsks: {
        key: () => ["hosted-asks"],
        queryOptions: () => ({ queryKey: ["hosted-asks"], queryFn: () => api.get() }),
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
  Switch: ({
    id,
    checked,
    disabled,
    onCheckedChange,
  }: {
    id: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (on: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import type * as Query from "../lib/query/query";
import { DozoHostedAsksRow } from "./dozo-hosted-asks-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const toggle = () => container.querySelector<HTMLInputElement>("input");

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoHostedAsksRow />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.set.mockImplementation(async ({ hostedAsks }) => {
    api.get.mockResolvedValue({ hostedAsks });
    return { hostedAsks };
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

it("shows nothing where the Space has no bot computer", async () => {
  api.get.mockResolvedValue({ hostedAsks: null });
  await render();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("shows nothing while the setting cannot be read", async () => {
  api.get.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(toggle()).toBeNull();
});

it("shows the setting, named by its label, and turns it off", async () => {
  api.get.mockResolvedValue({ hostedAsks: true });
  await render();
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  expect(container.querySelector(`label[for="${toggle()?.id}"]`)?.textContent).toBe(
    "Ask before commands on bot computers",
  );
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ hostedAsks: false });
  await vi.waitFor(() => expect(toggle()?.checked).toBe(false));
  expect(toggle()?.disabled).toBe(false);
});

it("shows the new value and holds the switch while a save is in flight", async () => {
  api.get.mockResolvedValue({ hostedAsks: false });
  const saving = deferred<{ hostedAsks: boolean }>();
  api.set.mockReturnValue(saving.promise);
  await render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  await act(async () => toggle()?.click());
  expect(toggle()?.checked).toBe(true);
  expect(toggle()?.disabled).toBe(true);
  api.get.mockResolvedValue({ hostedAsks: true });
  await act(async () => saving.resolve({ hostedAsks: true }));
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  expect(toggle()?.checked).toBe(true);
});

it("says so when the save fails, and shows the saved value again", async () => {
  api.get.mockResolvedValue({ hostedAsks: true });
  api.set.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  await act(async () => toggle()?.click());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Couldn't update this setting", expect.any(Error)),
  );
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
});
