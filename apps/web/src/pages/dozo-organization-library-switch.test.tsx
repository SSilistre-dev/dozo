// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), share: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoOrganizationLibrary: { share: api.share } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    agentSkills: { key: () => [["agentSkills"]] },
    dozoOrganizationLibrary: {
      key: () => [["dozoOrganizationLibrary"]],
      get: {
        queryOptions: () => ({
          queryKey: [["dozoOrganizationLibrary", "get"], { type: "query" }],
          queryFn: () => api.get(),
        }),
      },
    },
  }),
}));
vi.mock("../lib/dozo-error-text", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ children }: { children: ReactNode }) => <span data-label>{children}</span>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import type * as Query from "../lib/query";
import {
  DozoOrganizationLibrarySwitch,
  dozoOrganizationLibraryChanged,
} from "./dozo-organization-library-switch";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DozoOrganizationLibrarySwitch skillId="skill-1" />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
}

const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset();
  api.share.mockReset();
  api.toastError.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("is not there for a member, nor for an owner with nobody to share with", async () => {
  api.get.mockResolvedValue({ skillIds: [], canShare: false });
  await render();
  expect(container.textContent).toBe("");
});

it("puts the owner's skill in the library and takes it out again", async () => {
  api.get.mockResolvedValue({ skillIds: [], canShare: true });
  api.share.mockResolvedValue({ skillIds: ["skill-1"], canShare: true });
  await render();
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
  expect(container.querySelector("[data-label]")?.textContent).toBe("Organization");
  api.get.mockResolvedValue({ skillIds: ["skill-1"], canShare: true });
  await act(async () => toggle()!.click());
  expect(api.share).toHaveBeenCalledWith({ skillId: "skill-1", shared: true });
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
  api.get.mockResolvedValue({ skillIds: [], canShare: true });
  await act(async () => toggle()!.click());
  expect(api.share).toHaveBeenLastCalledWith({ skillId: "skill-1", shared: false });
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
});

it("says why when the server refuses, and shows the library as it is", async () => {
  api.get.mockResolvedValue({ skillIds: [], canShare: true });
  api.share.mockRejectedValue(new Error("Not found"));
  await render();
  await vi.waitFor(() => expect(toggle()).not.toBeNull());
  await act(async () => toggle()!.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Not found"));
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
});

it("reads the library and the skills again on the roster signal", async () => {
  const reads = new QueryClient();
  const invalidate = vi.spyOn(reads, "invalidateQueries").mockResolvedValue();
  await dozoOrganizationLibraryChanged(reads);
  const { predicate } = invalidate.mock.calls[0]![0] as unknown as {
    predicate: (query: { queryKey: unknown[] }) => boolean;
  };
  expect(predicate({ queryKey: [["user", "space", "agentSkills", "list"]] })).toBe(true);
  expect(predicate({ queryKey: [["user", "space", "dozoOrganizationLibrary", "get"]] })).toBe(true);
  expect(predicate({ queryKey: [["user", "space", "bots", "list"]] })).toBe(false);
  expect(predicate({ queryKey: ["plain"] })).toBe(false);
});
