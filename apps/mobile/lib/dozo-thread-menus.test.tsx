// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./mobile-types";

// Runs on the branded tree: the message procedures exist once the brand rules apply.

const api = vi.hoisted(() => ({ rpc: vi.fn(), push: vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: api.push } }));
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
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
vi.mock("./roster-signals", () => ({ useRosterSignals: () => undefined }));

import { takeEditDraft, useDozoMessageActions } from "./dozo-message-actions";
import { useDozoThreadMenus } from "./dozo-thread-menus";
import { queryClient } from "./query";

let root: Root;

const snap = (messages: string[], runs: { id: string; status: string }[] = [], extra = {}) =>
  ({
    threadId: "thread-1",
    olderCursor: null,
    run: null,
    activeRuns: runs,
    messages: messages.map((id) => ({ id, role: "user", blocks: [] })),
    ...extra,
  }) as unknown as MobileSnapshot;

function Chat({ s, readOnly = false }: { s: MobileSnapshot | null; readOnly?: boolean }) {
  useDozoThreadMenus(s, readOnly);
  return null;
}

const reads = (path: string) => api.rpc.mock.calls.filter(([called]) => called === path).length;

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  api.rpc
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "dozoMessages/pins"
        ? { pins: [] }
        : { editMessageId: "m-1", regenerateMessageId: null },
    );
  api.push.mockReset();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

it("reads what may change once, and again when the newest message or a run changes", async () => {
  await render(<Chat s={snap(["m-1"])} />);
  await vi.waitFor(() => expect(reads("dozoMessages/revisable")).toBe(1));
  expect(reads("dozoMessages/pins")).toBe(1);
  await render(<Chat s={snap(["m-1"])} />);
  expect(reads("dozoMessages/revisable")).toBe(1);
  await render(<Chat s={snap(["m-1", "m-2"])} />);
  await vi.waitFor(() => expect(reads("dozoMessages/revisable")).toBe(2));
  await render(<Chat s={snap(["m-1", "m-2"], [{ id: "run-1", status: "running" }])} />);
  await vi.waitFor(() => expect(reads("dozoMessages/revisable")).toBe(3));
  await render(<Chat s={snap(["m-1", "m-2"], [{ id: "run-1", status: "completed" }])} />);
  await vi.waitFor(() => expect(reads("dozoMessages/revisable")).toBe(4));
});

it("never asks in a group or a read-only chat, and reads nothing before the chat loads", async () => {
  await render(<Chat s={null} />);
  await render(<Chat s={snap(["m-1"], [], { groupId: "group-1" })} />);
  await render(<Chat s={snap(["m-1", "m-2"], [], { groupId: "group-1" })} />);
  await render(<Chat s={snap(["m-1", "m-3"])} readOnly />);
  expect(reads("dozoMessages/revisable")).toBe(0);
  expect(reads("dozoMessages/pins")).toBe(1);
});

it("opens the edit screen for the chat's message", async () => {
  let actions: ReturnType<typeof useDozoMessageActions> = [];
  function Row() {
    actions = useDozoMessageActions(
      { id: "m-1", threadId: "thread-1", role: "user", blocks: [{ kind: "text", text: "Hi" }] },
      false,
      false,
    );
    return null;
  }
  await render(
    <>
      <Chat s={snap(["m-1"])} />
      <Row />
    </>,
  );
  await act(() => vi.waitFor(() => expect(actions[0]?.name).toBe("dozoEdit")));
  actions[0]!.onPress();
  expect(api.push).toHaveBeenCalledWith({
    pathname: "/dozo-edit-message",
    params: { threadId: "thread-1", messageId: "m-1" },
  });
  expect(takeEditDraft("m-1")).toEqual({ text: "Hi", removes: null });
});

it("opens a message's Report on the feedback form, naming the message", async () => {
  api.rpc.mockImplementation(async (path: string) =>
    path === "dozoFeedback/status"
      ? { mode: "send" }
      : path === "dozoMessages/pins"
        ? { pins: [] }
        : { editMessageId: null, regenerateMessageId: null },
  );
  let actions: ReturnType<typeof useDozoMessageActions> = [];
  function Row() {
    actions = useDozoMessageActions(
      { id: "m-2", threadId: "thread-1", role: "bot", blocks: [{ kind: "text", text: "Hi" }] },
      false,
      false,
    );
    return null;
  }
  await render(<Row />);
  await act(() => vi.waitFor(() => expect(actions.at(-1)?.name).toBe("dozoReport")));
  actions.at(-1)!.onPress();
  expect(api.push).toHaveBeenCalledWith({
    pathname: "/dozo-feedback",
    params: { threadId: "thread-1", messageId: "m-2" },
  });
});
