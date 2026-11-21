// @vitest-environment jsdom
import type { DozoQueueItem } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  runsChanged: undefined as undefined | (() => unknown),
}));

vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space" },
  }),
  rpc: api.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./roster-signals", () => ({
  useSpaceChanges: (kind: string, onChange: () => unknown) => {
    if (kind === "runs") api.runsChanged = onChange;
  },
}));
vi.mock("./screen-query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const { queryClient } = await import("./query");
  return {
    useScreenQuery: (read: Parameters<typeof useQuery>[0]) => useQuery(read, queryClient),
  };
});

import { queueLine, queueSheet, useDozoQueue } from "./dozo-queue";
import { queryClient } from "./query";

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

let root: Root;
let queue: ReturnType<typeof useDozoQueue>;
function Probe() {
  queue = useDozoQueue({ botId: "bot-1" });
  return null;
}
const reads = () => api.rpc.mock.calls.filter(([path]) => path === "dozoQueue/list").length;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  api.alert.mockReset();
  api.runsChanged = undefined;
  api.rpc.mockReset().mockResolvedValue({ items: [] });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

it("says why your own work waits, with its place only when several wait", () => {
  expect(queueLine([item({ reason: "bot_busy" })])).toBe("Waiting in line…");
  expect(queueLine([item({ reason: "computer_busy" })])).toBe("Waiting in line…");
  expect(queueLine([item({ reason: "behind_run", waitingFor: "Daily report" })])).toBe(
    "Waiting in line… · After Daily report",
  );
  expect(queueLine([item({ reason: "behind_run" })])).toBe("Waiting in line…");
  expect(
    queueLine([
      item({ id: "other", mine: false, position: 1 }),
      item({ id: "mine", position: 2, reason: "computer_busy" }),
    ]),
  ).toBe("Waiting in line… · #2");
});

it("counts a place only among work waiting for the same bot, in a group chat", () => {
  const other = item({ id: "other", botId: "bot-2", mine: false, position: 1 });
  expect(queueLine([other, item({ id: "mine", position: 1 })])).toBe("Waiting in line…");
  expect(
    queueLine([
      other,
      item({ id: "same", mine: false, position: 1 }),
      item({ id: "mine", position: 2 }),
    ]),
  ).toBe("Waiting in line… · #2");
});

it("shows no line when none of the waiting work is yours", () => {
  expect(queueLine([])).toBeNull();
  expect(queueLine([item({ mine: false })])).toBeNull();
});

it("lists up to four rows, folds the rest into a count, and names unnamed work as queued", () => {
  const items = [
    item({ id: "a", position: 1, mine: false }),
    item({ id: "b", position: 2, label: "Summarize the file" }),
    item({ id: "c", position: 3, reason: "computer_busy", label: null }),
    item({ id: "d", position: 4, mine: false }),
    item({ id: "e", position: 5 }),
    item({ id: "f", position: 6, mine: false }),
  ];
  const sheet = queueSheet(items);
  expect(sheet.message.split("\n")).toEqual([
    "1  Queued",
    "2  Summarize the file",
    "3  Queued",
    "4  Queued",
    "+2",
  ]);
  expect(sheet.own.map((entry) => entry.id)).toEqual(["b", "c"]);
});

it("reads the line once and again on the Space's runs signal, never on a timer", async () => {
  await act(async () => root.render(<Probe />));
  await act(() => flush());
  await vi.waitFor(() => expect(reads()).toBe(1));
  api.rpc.mockResolvedValue({ items: [item({ id: "run-9" })] });
  await act(async () => {
    await api.runsChanged?.();
  });
  await vi.waitFor(() => expect(reads()).toBe(2));
  await vi.waitFor(() => expect(queue.items.map((entry) => entry.id)).toEqual(["run-9"]));
  expect(api.rpc.mock.calls[0]?.[1]).toEqual({ botId: "bot-1" });
});

it("stops waiting for your own run or message and reads the line again", async () => {
  await act(async () => root.render(<Probe />));
  await act(() => flush());
  await vi.waitFor(() => expect(reads()).toBe(1));
  api.rpc.mockImplementation(async (path: string) =>
    path === "dozoQueue/cancelWaiting" ? { cancelled: true } : { items: [] },
  );
  await act(async () => queue.cancel.run(item({ id: "run-1", kind: "run" })));
  await act(() => flush());
  await vi.waitFor(() =>
    expect(api.rpc.mock.calls.find(([path]) => path === "dozoQueue/cancelWaiting")?.[1]).toEqual({
      runId: "run-1",
    }),
  );
  await vi.waitFor(() => expect(reads()).toBe(2));
  await act(async () => queue.cancel.run(item({ id: "msg-1", kind: "message" })));
  await vi.waitFor(() =>
    expect(
      api.rpc.mock.calls.filter(([path]) => path === "dozoQueue/cancelWaiting")[1]?.[1],
    ).toEqual({ messageId: "msg-1" }),
  );
});

it("tells you when stopping fails", async () => {
  await act(async () => root.render(<Probe />));
  await act(() => flush());
  api.rpc.mockImplementation(async (path: string) => {
    if (path === "dozoQueue/cancelWaiting") throw new Error("nope");
    return { items: [] };
  });
  await act(async () => queue.cancel.run(item({})));
  await vi.waitFor(() => expect(api.alert).toHaveBeenCalledTimes(1));
});
