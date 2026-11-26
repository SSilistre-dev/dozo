// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
  now: Date.UTC(2026, 10, 20, 12),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { dozoModelPool: { get: api.get, set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@rakazo/chat-ui/hooks", () => ({ useNow: () => api.now }));
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
}));

import { DozoConnectionDetail, DozoModelPoolSwitch, dozoModelPoolChanged } from "./dozo-model-pool";

const HOUR = 60 * 60_000;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const pool = (connections: { credentialId: string; pooled: boolean; opensAt?: string }[]) => ({
  connections,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockReset();
  api.set.mockReset();
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

describe("the pool switch", () => {
  it("is absent where the server offers no pool", async () => {
    api.get.mockResolvedValue(pool([{ credentialId: "b", pooled: false }]));
    await render(<DozoModelPoolSwitch credentialId="a" />);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("turns the pool on, named by its label, and shows what the server saved", async () => {
    api.get.mockResolvedValue(pool([{ credentialId: "a", pooled: false }]));
    api.set.mockImplementation(async ({ pooled }) => {
      const saved = pool([{ credentialId: "a", pooled }]);
      api.get.mockResolvedValue(saved);
      return saved;
    });
    await render(<DozoModelPoolSwitch credentialId="a" />);
    await vi.waitFor(() => expect(toggle()?.checked).toBe(false));
    expect(container.querySelector(`label[for="${toggle()?.id}"]`)?.textContent).toBe(
      "Use the next connection when one runs out",
    );
    await act(async () => toggle()?.click());
    expect(api.set).toHaveBeenCalledWith({ credentialId: "a", pooled: true });
    await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  });

  it("says so when the save fails, and shows the saved state again", async () => {
    api.get.mockResolvedValue(pool([{ credentialId: "a", pooled: true }]));
    const failure = new Error("down");
    api.set.mockRejectedValue(failure);
    await render(<DozoModelPoolSwitch credentialId="a" />);
    await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
    await act(async () => toggle()?.click());
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not save", failure));
    await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  });
});

describe("a connection row's detail", () => {
  const row = (credentialId = "a") => (
    <DozoConnectionDetail credentialId={credentialId}>
      <span>3 models</span>
    </DozoConnectionDetail>
  );

  it("shows the time a resting connection opens instead of what the row says", async () => {
    api.get.mockResolvedValue(
      pool([
        { credentialId: "a", pooled: true, opensAt: new Date(api.now + 2 * HOUR).toISOString() },
      ]),
    );
    await render(row());
    await vi.waitFor(() => expect(container.textContent).toMatch(/^Opens at \d{1,2}:\d{2}/));
    expect(container.textContent).not.toContain("models");
  });

  it("adds the day when it opens on another one", async () => {
    api.get.mockResolvedValue(
      pool([
        { credentialId: "a", pooled: true, opensAt: new Date(api.now + 72 * HOUR).toISOString() },
      ]),
    );
    await render(row());
    await vi.waitFor(() => expect(container.textContent).toContain("Opens at"));
    expect(container.textContent).toContain("Nov");
  });

  it("keeps what the row says once the time passed, and for any other connection", async () => {
    api.get.mockResolvedValue(
      pool([
        { credentialId: "a", pooled: true, opensAt: new Date(api.now - HOUR).toISOString() },
        { credentialId: "b", pooled: true },
      ]),
    );
    await render(
      <>
        {row("a")}
        {row("b")}
        {row("c")}
      </>,
    );
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("3 models3 models3 models");
  });
});

it("reads the pool again on the signal, and nothing else", async () => {
  const other = new QueryClient();
  other.setQueryData(["dozoModelPool", "user-1"], pool([]));
  other.setQueryData([["models", "credentials"]], []);
  await dozoModelPoolChanged(other);
  expect(other.getQueryState(["dozoModelPool", "user-1"])?.isInvalidated).toBe(true);
  expect(other.getQueryState([["models", "credentials"]])?.isInvalidated).toBe(false);
});
