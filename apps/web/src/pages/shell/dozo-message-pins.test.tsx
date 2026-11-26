// @vitest-environment jsdom
import type { DozoMessagePin, ThreadMessage } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  pins: vi.fn(),
  pin: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { dozoMessages: { pin: api.pin } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoMessages: {
      pins: {
        key: ({ input }: { input: { threadId: string } }) => [
          ["dozoMessages", "pins"],
          input.threadId,
        ],
        queryOptions: ({ input }: { input: { threadId: string } }) => ({
          queryKey: [["dozoMessages", "pins"], input.threadId],
          queryFn: () => api.pins(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactElement }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => (
    <div data-trigger>
      {render}
      {children}
    </div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" role="menuitem" {...props}>
      {children}
    </button>
  ),
}));

import type * as Query from "../../lib/query/query";
import { DozoPinMenuItem, DozoPinnedMessages, dozoPinsChanged } from "./dozo-message-pins";

const message: ThreadMessage = {
  id: "m-1",
  threadId: "thread-1",
  seq: 3,
  role: "bot",
  blocks: [{ kind: "text", text: "Pasta." }],
  createdAt: "2026-11-20T10:00:00.000Z",
};
const pin = (messageId: string, preview: Partial<DozoMessagePin["preview"]> = {}) => ({
  messageId,
  preview: { role: "bot" as const, text: "", ...preview },
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

function Location() {
  return <output data-search>{useLocation().search}</output>;
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/chat?keep=1"]}>
          {node}
          <Location />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const menuItems = () =>
  [...container.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
const click = (node: Element | null | undefined) =>
  act(async () => {
    if (!node) throw new Error("Missing control");
    (node as HTMLElement).click();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.pins.mockReset();
  api.pin.mockReset();
  api.toastError.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows nothing in the header while the chat has no pins", async () => {
  api.pins.mockResolvedValue({ pins: [] });
  await render(<DozoPinnedMessages threadId="thread-1" />);
  await vi.waitFor(() => expect(api.pins).toHaveBeenCalledWith({ threadId: "thread-1" }));
  expect(container.querySelector('[data-testid="dozo-pinned-messages"]')).toBeNull();
});

it("reads nothing before the chat is known", async () => {
  await render(<DozoPinnedMessages threadId={undefined} />);
  expect(api.pins).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="dozo-pinned-messages"]')).toBeNull();
});

it("lists the pins and opens the chat at the one chosen", async () => {
  api.pins.mockResolvedValue({
    pins: [
      pin("m-1", { text: "Pasta." }),
      pin("m-2", {
        attachment: { kind: "file", artifactId: "a", mimeType: "x", name: "menu.pdf" },
      }),
      pin("m-3", { page: true }),
      pin("m-4"),
    ],
  });
  await render(<DozoPinnedMessages threadId="thread-1" />);
  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-testid="dozo-pinned-messages"]')?.getAttribute("aria-label"),
    ).toBe("Pinned"),
  );
  expect(menuItems()).toEqual(["Pasta.", "menu.pdf", "Page", "Message"]);
  await click(container.querySelector('[role="menuitem"]'));
  expect(container.querySelector("[data-search]")?.textContent).toBe("?keep=1&m=m-1");
});

it("offers Pin on a message that is not pinned and pins it", async () => {
  api.pins.mockResolvedValueOnce({ pins: [] }).mockResolvedValue({ pins: [pin("m-1")] });
  api.pin.mockResolvedValue({ pinned: true });
  await render(<DozoPinMenuItem message={message} menuOpen />);
  await vi.waitFor(() => expect(menuItems()).toEqual(["Pin"]));
  await click(container.querySelector('[role="menuitem"]'));
  expect(api.pin).toHaveBeenCalledWith({ threadId: "thread-1", messageId: "m-1", pinned: true });
  await vi.waitFor(() => expect(menuItems()).toEqual(["Unpin"]));
});

it("offers Unpin on a pinned message and reports a failure", async () => {
  api.pins.mockResolvedValue({ pins: [pin("m-1")] });
  api.pin.mockRejectedValue(new Error("Resource not found"));
  await render(<DozoPinMenuItem message={message} menuOpen />);
  await vi.waitFor(() => expect(menuItems()).toEqual(["Unpin"]));
  await click(container.querySelector('[role="menuitem"]'));
  expect(api.pin).toHaveBeenCalledWith({ threadId: "thread-1", messageId: "m-1", pinned: false });
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Resource not found"));
});

it("offers nothing until the menu is open and the pins are read", async () => {
  await render(<DozoPinMenuItem message={message} menuOpen={false} />);
  expect(api.pins).not.toHaveBeenCalled();
  expect(menuItems()).toEqual([]);
});

it("reads only the pins again on a roster signal", async () => {
  const other = vi.fn(async () => "x");
  api.pins.mockResolvedValue({ pins: [] });
  await render(<DozoPinnedMessages threadId="thread-1" />);
  await vi.waitFor(() => expect(api.pins).toHaveBeenCalledTimes(1));
  await client.fetchQuery({ queryKey: [["spaces", "list"]], queryFn: other });
  await act(() => dozoPinsChanged(client));
  expect(api.pins).toHaveBeenCalledTimes(2);
  expect(other).toHaveBeenCalledTimes(1);
});
