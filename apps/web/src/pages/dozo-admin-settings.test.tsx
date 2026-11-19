// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoSiteSettings: { update: api.update } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: () => api.me() }) },
    dozoSiteSettings: {
      get: {
        key: () => ["settings"],
        queryOptions: () => ({ queryKey: ["settings"], queryFn: () => api.get() }),
      },
      announcement: { key: () => ["announcement"] },
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
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  buttonVariants: () => "",
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Spinner: () => <span role="status" />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
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
import { DozoAdminSettingsPage } from "./dozo-admin-settings";

const settings = {
  signupsOpen: null,
  maxComputersPerUser: null,
  announcementEn: "",
  announcementTr: "",
  environment: { signupsOpen: false, maxComputersPerUser: 3 },
  memoryBudgetGb: null,
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
          <DozoAdminSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const labelled = <T extends Element = HTMLInputElement>(label: string) =>
  container.querySelector<T & Element>(`[aria-label="${label}"]`);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

async function open() {
  await render();
  await vi.waitFor(() => expect(labelled("Sign-up open")).toBeTruthy());
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
  api.me.mockResolvedValue({ isAdmin: true, userId: "admin" });
  api.get.mockResolvedValue(settings);
  api.update.mockResolvedValue(settings);
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
  expect(container.querySelector('[data-testid="page-loading"]')).toBeTruthy();
  await act(async () => me.resolve({ isAdmin: false }));
  await vi.waitFor(() => expect(container.querySelector('[data-testid="not-found"]')).toBeTruthy());
  expect(api.get).not.toHaveBeenCalled();
});

it("shows what the environment says until an admin sets it, with nothing to save", async () => {
  await open();
  expect(labelled("Sign-up open")?.checked).toBe(false);
  expect(button("Reset")).toBeUndefined();
  expect(labelled("Computers per person")?.placeholder).toBe("3");
  expect(labelled("Computers per person")?.value).toBe("");
  // No memory budget reported, no row for it.
  expect(container.textContent).not.toContain("Computer memory");
  expect(button("Save")).toBeUndefined();
});

it("saves the sign-up switch at once, and resets it to the environment", async () => {
  api.update.mockResolvedValue({ ...settings, signupsOpen: true });
  await open();
  api.get.mockClear();
  api.get.mockResolvedValue({ ...settings, signupsOpen: true });
  await act(async () => labelled("Sign-up open")?.click());
  expect(api.update).toHaveBeenCalledWith({ signupsOpen: true });
  await vi.waitFor(() => expect(button("Reset")).toBeTruthy());
  expect(labelled("Sign-up open")?.checked).toBe(true);
  await act(async () => button("Reset")?.click());
  expect(api.update).toHaveBeenLastCalledWith({ signupsOpen: null });
});

it("saves the cap and the announcement together; an empty cap follows the environment", async () => {
  await open();
  await type("Computers per person", "2");
  await type("Announcement in English", "Maintenance at 22:00");
  await type("Announcement in Turkish", "22:00'de bakım");
  await act(async () => button("Save")?.click());
  expect(api.update).toHaveBeenCalledWith({
    maxComputersPerUser: 2,
    announcementEn: "Maintenance at 22:00",
    announcementTr: "22:00'de bakım",
  });
  api.update.mockClear();
  await type("Computers per person", "");
  await type("Announcement in English", "");
  await type("Announcement in Turkish", "");
  // Back to what was loaded: nothing to save.
  expect(button("Save")).toBeUndefined();
});

it("sends only what was edited, so another admin's change to the rest stays", async () => {
  api.get.mockResolvedValue({ ...settings, maxComputersPerUser: 2, announcementEn: "Old" });
  await open();
  await type("Announcement in Turkish", "Bakım");
  await act(async () => button("Save")?.click());
  expect(api.update).toHaveBeenCalledWith({ announcementTr: "Bakım" });
});

it("shows the memory budget read only, and a cap of none as no limit", async () => {
  api.get.mockResolvedValue({
    ...settings,
    maxComputersPerUser: 4,
    environment: { signupsOpen: true, maxComputersPerUser: 0 },
    memoryBudgetGb: 11.94,
  });
  await open();
  expect(container.textContent).toContain("Computer memory");
  expect(container.textContent).toContain("11.9 GB");
  expect(labelled("Computers per person")?.value).toBe("4");
  expect(labelled("Computers per person")?.placeholder).toBe("No limit");
  expect(labelled("Sign-up open")?.checked).toBe(true);
});

it("says when a save fails", async () => {
  api.update.mockRejectedValue(new Error("Only admins"));
  await open();
  await act(async () => labelled("Sign-up open")?.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Only admins"));
});

it("offers a retry when the settings cannot be read", async () => {
  api.get.mockRejectedValueOnce(new Error("Down"));
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Down"),
  );
  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(labelled("Sign-up open")).toBeTruthy());
});
