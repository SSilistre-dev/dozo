// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { DozoLearningChange } from "@rakazo/contracts";
import { DOZO_LEARNING_CHANGED_CODE } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  setMode: vi.fn(),
  undo: vi.fn(),
  memoryList: vi.fn(async () => []),
  budget: vi.fn(async () => ({ limitBytes: 1, usedBytes: 0, documents: [], omitted: [] })),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = {
    dozoLearning: { get: api.get, setMode: api.setMode, undo: api.undo },
    memory: { list: api.memoryList, budget: api.budget },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/dozo-error-text", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button type="button" {...props} />,
  SectionHeading: ({
    variant: _variant,
    ...props
  }: ComponentProps<"h3"> & { variant?: string }) => <h3 {...props} />,
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

import { QueryUserProvider } from "../lib/query";
import { dozoLearningChanged } from "./dozo-learning-changed";
import { DozoLearningSection } from "./dozo-learning-section";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

function change(id: string, overrides: Partial<DozoLearningChange> = {}): DozoLearningChange {
  return {
    id,
    kind: "add",
    before: null,
    after: `Line ${id}`,
    createdAt: "2026-11-22T10:00:00.000Z",
    undoneAt: null,
    ...overrides,
  };
}

/** Signed in as the bot's owner unless another user or owner is given. */
async function show(options: { me?: string | null; ownerId?: string | null } = {}) {
  const { me = "user-1", ownerId = "user-1" } = options;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value={me}>
          <DozoLearningSection botId="bot-1" ownerId={ownerId} />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
}

async function render() {
  await show();
  await vi.waitFor(() => expect(toggle()).not.toBeNull());
}

const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]');
const undoButton = (line: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const ids = button.getAttribute("aria-labelledby")?.split(" ") ?? [];
    const name = ids.map((id) => document.getElementById(id)?.textContent).join(" ");
    return name === `Undo ${line}`;
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of [api.get, api.setMode, api.undo, api.toastError]) fn.mockReset();
  api.memoryList.mockClear();
  api.budget.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("turns learning on and off through setMode, the switch labelled by its text", async () => {
  api.get.mockResolvedValue({ mode: "off", available: true, changes: [] });
  await render();
  expect(api.get).toHaveBeenCalledWith({ botId: "bot-1" }, expect.anything());
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(toggle()?.closest("label")?.textContent).toBe("Learn from chats");
  api.setMode.mockResolvedValue({ mode: "auto" });
  api.get.mockResolvedValue({ mode: "auto", available: true, changes: [] });
  await act(async () => toggle()!.click());
  expect(api.setMode).toHaveBeenCalledWith({ botId: "bot-1", mode: "auto" });
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
  api.setMode.mockResolvedValue({ mode: "off" });
  api.get.mockResolvedValue({ mode: "off", available: true, changes: [] });
  await act(async () => toggle()!.click());
  expect(api.setMode).toHaveBeenLastCalledWith({ botId: "bot-1", mode: "off" });
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
});

it("says why the server refused the switch and shows the mode as it is", async () => {
  api.get.mockResolvedValue({ mode: "off", available: true, changes: [] });
  api.setMode.mockRejectedValue(new Error("Only the owner can change this"));
  await render();
  await act(async () => toggle()!.click());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Only the owner can change this"),
  );
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
});

it("lists nothing while there are no changes, nor once all are undone", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { undoneAt: "2026-11-22T11:00:00.000Z" })],
  });
  await render();
  expect(container.textContent).toBe("Learn from chats");
  expect(container.querySelector("h3")).toBeNull();
});

it("lists additions by their new line and removals struck through by their old one", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [
      change("c1", { after: "Prefers tea" }),
      change("c2", { kind: "update", before: "Lives in Izmir", after: "Lives in Ankara" }),
      change("c3", { kind: "remove", before: "Has a dog", after: null }),
    ],
  });
  await render();
  expect(container.querySelector("h3")?.textContent).toBe("Learned");
  expect(undoButton("Prefers tea")).toBeDefined();
  expect(undoButton("Lives in Ankara")).toBeDefined();
  expect(container.textContent).not.toContain("Izmir");
  const struck = container.querySelector("s");
  expect(struck?.textContent).toBe("Has a dog");
  expect(undoButton("Has a dog")).toBeDefined();
});

it("undoes one change, then reads the list and the bot's memory again without that row", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { after: "Prefers tea" }), change("c2", { after: "Works nights" })],
  });
  await render();
  api.undo.mockResolvedValue(change("c1", { undoneAt: "2026-11-22T11:00:00.000Z" }));
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [
      change("c1", { after: "Prefers tea", undoneAt: "2026-11-22T11:00:00.000Z" }),
      change("c2", { after: "Works nights" }),
    ],
  });
  // The memory list and budget as the Memory section caches them: undo rewrites MEMORY.md.
  const memoryKeys = [
    [
      ["user:user-1", "space:", "memory", "list"],
      { input: { botId: "bot-1", scope: "bot" }, type: "query" },
    ],
    [["user:user-1", "space:", "memory", "budget"], { input: { botId: "bot-1" }, type: "query" }],
  ];
  for (const queryKey of memoryKeys) client.setQueryData(queryKey, []);
  await act(async () => undoButton("Prefers tea")!.click());
  expect(api.undo).toHaveBeenCalledWith({ changeId: "c1" });
  await vi.waitFor(() => expect(undoButton("Prefers tea")).toBeUndefined());
  expect(undoButton("Works nights")).toBeDefined();
  for (const queryKey of memoryKeys) {
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  }
  expect(api.toastError).not.toHaveBeenCalled();
});

it("says a line changed since on its own row instead of undoing it", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { after: "Prefers tea" }), change("c2", { after: "Works nights" })],
  });
  api.undo.mockRejectedValue(
    new ORPCError(DOZO_LEARNING_CHANGED_CODE, {
      status: 409,
      message: "This note was changed since it was learned.",
    }),
  );
  await render();
  await act(async () => undoButton("Prefers tea")!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Changed since"));
  const rows = [...container.querySelectorAll("li")];
  expect(rows[0]?.textContent).toContain("Changed since");
  expect(rows[1]?.textContent).not.toContain("Changed since");
  expect(undoButton("Works nights")).toBeDefined();
  expect(api.toastError).not.toHaveBeenCalled();
});

it("says why another undo failed", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { after: "Prefers tea" })],
  });
  api.undo.mockRejectedValue(new Error("Could not save"));
  await render();
  await act(async () => undoButton("Prefers tea")!.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not save"));
  expect(container.textContent).not.toContain("Changed since");
  expect(undoButton("Prefers tea")).toBeDefined();
});

it("shows nothing when the learning cannot be read", async () => {
  api.get.mockRejectedValue(new Error("Not found"));
  await show();
  expect(container.textContent).toBe("");
});

it("shows nothing to anyone but the bot's owner, and reads nothing for them", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { after: "Prefers tea" })],
  });
  for (const [me, ownerId] of [
    ["user-2", "user-1"],
    ["user-1", null],
    [null, "user-1"],
  ] as const) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <QueryUserProvider value={me}>
            <DozoLearningSection botId="bot-1" ownerId={ownerId} />
          </QueryUserProvider>
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toBe("");
    client.clear();
  }
  expect(api.get).not.toHaveBeenCalled();
});

it("offers no switch in a Space with someone else, and still lists what was learned", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: false,
    changes: [change("c1", { after: "Prefers tea" })],
  });
  await show();
  await vi.waitFor(() => expect(undoButton("Prefers tea")).toBeDefined());
  expect(toggle()).toBeNull();
  expect(container.textContent).not.toContain("Learn from chats");
  expect(container.querySelector("h3")?.className).toBe("mb-2");
});

it("shows nothing in a Space with someone else while nothing was learned", async () => {
  api.get.mockResolvedValue({ mode: "off", available: false, changes: [] });
  await show();
  await act(async () => undefined);
  expect(container.textContent).toBe("");
});

it("reads the learned list and the bot's memory again on a roster signal, and nothing else", async () => {
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c1", { after: "Prefers tea" })],
  });
  await render();
  expect(api.get).toHaveBeenCalledTimes(1);
  const memoryKeys = [
    [
      ["user:user-1", "space:", "memory", "list"],
      { input: { botId: "bot-1", scope: "bot" }, type: "query" },
    ],
    [["user:user-1", "space:", "memory", "budget"], { input: { botId: "bot-1" }, type: "query" }],
  ];
  const otherKeys = [
    [["user:user-1", "space:", "memory", "list"], { input: { scope: "user" }, type: "query" }],
    [["user:user-1", "space:", "spaces", "list"], { type: "query" }],
  ];
  for (const queryKey of [...memoryKeys, ...otherKeys]) client.setQueryData(queryKey, []);
  api.get.mockResolvedValue({
    mode: "auto",
    available: true,
    changes: [change("c2", { after: "Works nights" }), change("c1", { after: "Prefers tea" })],
  });
  await act(() => dozoLearningChanged(client));
  await vi.waitFor(() => expect(undoButton("Works nights")).toBeDefined());
  expect(api.get).toHaveBeenCalledTimes(2);
  for (const queryKey of memoryKeys)
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  for (const queryKey of otherKeys)
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(false);
});
