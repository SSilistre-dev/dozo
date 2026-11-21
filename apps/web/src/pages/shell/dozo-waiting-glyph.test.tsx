// @vitest-environment jsdom
import type { DozoQueueItem } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn(), toastError: vi.fn() }));

vi.mock("../../lib/rpc", () => {
  const rpc = { dozoQueue: { cancelWaiting: api.cancel } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoQueue: {
      list: {
        key: () => ["dozoQueue", "list"],
        queryOptions: ({ input }: { input: object }) => ({
          queryKey: ["dozoQueue", "list", input],
          queryFn: () => api.list(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: () => "failed",
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("../../components/ai/CollaborationMarker", () => ({
  ActiveBotGlyph: ({ label }: { label: string }) => <div role="status">{label}</div>,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div data-trigger>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-list>{children}</div>,
}));

import type * as Query from "../../lib/query";
import { DozoWaitingGlyph } from "./dozo-waiting-glyph";

const item = (over: Partial<DozoQueueItem>): DozoQueueItem => ({
  id: "run-1",
  kind: "run",
  botId: "bot-1",
  position: 1,
  mine: true,
  reason: "bot_busy",
  waitingFor: null,
  label: null,
  ...over,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(items: DozoQueueItem[]) {
  api.list.mockResolvedValue({ items });
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoWaitingGlyph bots={[]} label="Working…" target={{ botId: "bot-1" }} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
  if (items.some((entry) => entry.mine))
    await vi.waitFor(() => expect(container.querySelector("[data-trigger]")).not.toBeNull());
}
const status = () => container.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  api.cancel.mockResolvedValue({ cancelled: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps the working line when nothing of mine waits", async () => {
  await render([item({ mine: false, id: "run-9" })]);
  expect(status()).toBe("Working…");
  expect(container.querySelector("[data-list]")).toBeNull();
  expect(api.list).toHaveBeenCalledWith({ botId: "bot-1" });
});

it.each([
  ["computer_busy", "Waiting in line… · Computer busy"],
  ["bot_busy", "Waiting in line… · Busy elsewhere"],
  ["behind_run", "Waiting in line… · Busy elsewhere"],
] as const)("says what a %s wait waits for", async (reason, text) => {
  await render([item({ reason })]);
  expect(status()).toBe(text);
});

it("names the routine a held message waits behind", async () => {
  await render([item({ reason: "behind_run", waitingFor: "Daily digest" })]);
  expect(status()).toBe("Waiting in line… · After Daily digest");
});

it("adds my place when several wait", async () => {
  await render([
    item({ id: "run-0", mine: false, position: 1 }),
    item({ id: "run-1", position: 2, reason: "computer_busy" }),
  ]);
  expect(status()).toBe("Waiting in line… · Computer busy · #2");
});

it("lists my work by name, others' as another task without a cancel, and folds the rest", async () => {
  await render([
    item({ id: "a", position: 1, mine: false }),
    item({ id: "b", position: 2, label: "Book a table" }),
    item({ id: "c", position: 3, mine: false }),
    item({ id: "d", position: 4, mine: false }),
    item({ id: "e", position: 5, mine: false }),
    item({ id: "f", position: 6, mine: false }),
  ]);
  const rows = [...container.querySelectorAll("[data-row]")];
  expect(rows).toHaveLength(4);
  expect(rows[0]?.textContent).toContain("Another task");
  expect(rows[0]?.querySelector("button")).toBeNull();
  expect(rows[1]?.textContent).toContain("Book a table");
  expect(rows[1]?.querySelector("button")).not.toBeNull();
  expect(container.querySelector("[data-list]")?.textContent).toContain("+2");
});

it("cancels my own wait by run or by message", async () => {
  await render([
    item({ id: "run-1", label: "Book a table" }),
    item({ id: "msg-1", kind: "message", position: 2, label: "Hello" }),
  ]);
  const stops = container.querySelectorAll<HTMLButtonElement>('[aria-label="Stop waiting"]');
  await act(async () => stops[0]?.click());
  expect(api.cancel).toHaveBeenLastCalledWith({ runId: "run-1" });
  await act(async () => stops[1]?.click());
  expect(api.cancel).toHaveBeenLastCalledWith({ messageId: "msg-1" });
});

it("tells why a stop failed and keeps the line", async () => {
  api.cancel.mockRejectedValue(new Error("not found"));
  await render([item({ id: "run-1", label: "Book a table" })]);
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop waiting"]');
  await act(async () => stop?.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("failed"));
  expect(status()).toBe("Waiting in line… · Busy elsewhere");
});
