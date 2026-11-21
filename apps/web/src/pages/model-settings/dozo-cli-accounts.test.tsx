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
  addAccount: vi.fn(),
  sendCode: vi.fn(),
  cancelLogin: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const read = async () => [];
  // The query helpers are built from this client, so the reads a save invalidates must exist.
  const rpc = Object.assign(read, {
    models: { list: read, credentials: read },
    dozoCliAccounts: {
      list: api.list,
      connect: api.connect,
      addAccount: api.addAccount,
      sendCode: api.sendCode,
      cancelLogin: api.cancelLogin,
    },
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
  Input: (props: ComponentProps<"input">) => <input {...props} />,
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
  canAdd: false,
  ...over,
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === text);
const codeField = () => container.querySelector<HTMLInputElement>('input[aria-label="Code"]');

/** Types into a controlled field the way a person does. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of Object.values(api)) fn.mockReset();
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
  it("shows nothing where the server lists no tool with something to do", async () => {
    api.list.mockResolvedValue({
      tools: [tool({ found: false, canAdd: true }), tool({ provider: "tool-b", connected: true })],
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("says a tool is not signed in instead of offering it", async () => {
    api.list.mockResolvedValue({ tools: [tool({ signedIn: false })] });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(container.textContent).toBe("Tool ANot signed in"));
    expect(container.querySelector("button")).toBeNull();
  });

  it("connects the person's own sign-in and shows what the server saved", async () => {
    api.list.mockResolvedValue({ tools: [tool()] });
    api.connect.mockImplementation(async () => {
      const saved = { tools: [tool({ connected: true })] };
      api.list.mockResolvedValue(saved);
      return saved;
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button("Connect")).toBeDefined());
    await act(async () => button("Connect")?.click());
    expect(api.connect).toHaveBeenCalledWith({ provider: "tool-a" });
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("says so when connecting fails", async () => {
    api.list.mockResolvedValue({ tools: [tool()] });
    const failure = new Error("Sign in first.");
    api.connect.mockRejectedValue(failure);
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button("Connect")).toBeDefined());
    await act(async () => button("Connect")?.click());
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not connect", failure),
    );
  });
});

describe("another account", () => {
  const waiting = (url?: string) =>
    tool({ connected: true, canAdd: true, login: { status: "waiting", ...(url ? { url } : {}) } });

  it("starts the tool's own sign-in, one at a time", async () => {
    api.list.mockResolvedValue({ tools: [tool({ connected: true, canAdd: true })] });
    api.addAccount.mockImplementation(async () => {
      const started = { tools: [waiting()] };
      api.list.mockResolvedValue(started);
      return started;
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button("Add account")).toBeDefined());
    expect(button("Connect")).toBeUndefined();
    await act(async () => button("Add account")?.click());
    expect(api.addAccount).toHaveBeenCalledWith({ provider: "tool-a" });
    await vi.waitFor(() => expect(codeField()).not.toBeNull());
    expect(button("Add account")).toBeUndefined();
  });

  it("says so when the sign-in cannot start", async () => {
    api.list.mockResolvedValue({ tools: [tool({ connected: true, canAdd: true })] });
    const failure = new Error("Not installed.");
    api.addAccount.mockRejectedValue(failure);
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button("Add account")).toBeDefined());
    await act(async () => button("Add account")?.click());
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not add the account", failure),
    );
  });

  it("opens the address the tool printed in a new tab, and sends the pasted code", async () => {
    api.list.mockResolvedValue({ tools: [waiting("https://sign-in.example/start")] });
    const failure = new Error("That code is not valid.");
    api.sendCode.mockRejectedValue(failure);
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(container.querySelector("a")).not.toBeNull());
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Open sign-in page");
    expect(link?.getAttribute("href")).toBe("https://sign-in.example/start");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(button("Send")?.disabled).toBe(true);
    await act(async () => type(codeField() as HTMLInputElement, "abc#123"));
    await act(async () => button("Send")?.click());
    expect(api.sendCode).toHaveBeenCalledWith({ provider: "tool-a", code: "abc#123" });
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not send the code", failure),
    );
  });

  it("cancels the sign-in, and says so when it cannot", async () => {
    api.list.mockResolvedValue({ tools: [waiting()] });
    const failure = new Error("down");
    api.cancelLogin.mockRejectedValue(failure);
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(button("Cancel")).toBeDefined());
    await act(async () => button("Cancel")?.click());
    expect(api.cancelLogin).toHaveBeenCalledWith({ provider: "tool-a" });
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not cancel", failure),
    );
  });

  it("says why a sign-in ended, and offers to try again", async () => {
    api.list.mockResolvedValue({
      tools: [
        tool({
          connected: true,
          login: { status: "failed", error: "Sign-in did not finish." },
        }),
      ],
    });
    await render(<DozoCliAccounts />);
    await vi.waitFor(() => expect(container.textContent).toContain("Sign-in did not finish."));
    expect(codeField()).toBeNull();
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
