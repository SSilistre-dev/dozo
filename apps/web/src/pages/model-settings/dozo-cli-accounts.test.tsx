// @vitest-environment jsdom
import type { DozoCliTool } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const read = async () => [];
  // The query helpers are built from this client, so the reads a save invalidates must exist.
  const rpc = Object.assign(read, {
    models: { list: read, credentials: read },
    dozoCliAccounts: { list: api.list, connect: api.connect },
  });
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { DozoCliAccounts, dozoCliAccountsChanged, useDozoCliProviders } from "./dozo-cli-accounts";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

const tool = (over: Partial<DozoCliTool> = {}): DozoCliTool => ({
  provider: "tool-a",
  name: "Tool A",
  found: true,
  signedIn: true,
  connected: false,
  ...over,
});
const button = () => container.querySelector("button");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset();
  api.connect.mockReset();
  api.toastError.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("tools on this computer", () => {
  it("shows nothing where the server lists no tool to connect", async () => {
    api.list.mockResolvedValue({
      tools: [tool({ found: false }), tool({ provider: "tool-b", connected: true })],
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("says a tool is not signed in instead of offering it", async () => {
    api.list.mockResolvedValue({ tools: [tool({ signedIn: false })] });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(container.textContent).toBe("Tool ANot signed in"));
    expect(button()).toBeNull();
  });

  it("connects the person's own sign-in and shows what the server saved", async () => {
    api.list.mockResolvedValue({ tools: [tool()] });
    api.connect.mockImplementation(async () => {
      const saved = { tools: [tool({ connected: true })] };
      api.list.mockResolvedValue(saved);
      return saved;
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button()?.textContent).toBe("Connect"));
    await act(async () => button()?.click());
    expect(api.connect).toHaveBeenCalledWith({ provider: "tool-a" });
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("says so when connecting fails", async () => {
    api.list.mockResolvedValue({ tools: [tool()] });
    const failure = new Error("Sign in first.");
    api.connect.mockRejectedValue(failure);
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button()).not.toBeNull());
    await act(async () => button()?.click());
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not connect", failure),
    );
  });
});

it("names the providers connected only from here", async () => {
  api.list.mockResolvedValue({ tools: [tool(), tool({ provider: "tool-b", found: false })] });
  const seen: string[][] = [];
  function Probe() {
    seen.push([...useDozoCliProviders()]);
    return null;
  }
  await render(<Probe />);
  await vi.waitFor(() => expect(seen.at(-1)).toEqual(["tool-a", "tool-b"]));
  expect(seen[0]).toEqual([]);
});

it("reads the tools again on the signal, and nothing else", async () => {
  const other = new QueryClient();
  other.setQueryData(["dozoCliAccounts", "user-1"], { tools: [] });
  other.setQueryData([["models", "credentials"]], []);
  await dozoCliAccountsChanged(other);
  expect(other.getQueryState(["dozoCliAccounts", "user-1"])?.isInvalidated).toBe(true);
  expect(other.getQueryState([["models", "credentials"]])?.isInvalidated).toBe(false);
});
