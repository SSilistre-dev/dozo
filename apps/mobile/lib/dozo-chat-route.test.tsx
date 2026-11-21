// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  inboxThread: undefined as string | undefined,
  rpc: vi.fn(),
  mounts: [] as (string | undefined)[],
}));

const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => createElement("progress"),
  Alert: { alert: vi.fn() },
  Pressable: element("button"),
  Text: element("span"),
  View: element("div"),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
}));
vi.mock("./organizations", () => ({ selectSpaceAcrossOrganizations: vi.fn() }));
vi.mock("./integrations-cache", () => ({ integrationsCacheScope: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => 1,
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => undefined,
  loadVerifiedIntegrationsScope: async () => ({
    apiBase: "https://app.example.test",
    userId: "user-1",
  }),
}));
vi.mock("./user-error", () => ({ errorText: () => "error" }));
vi.mock("./search-inbox", () => ({
  useInboxBot: (botId?: string) =>
    botId && state.inboxThread ? { id: botId, threadId: state.inboxThread } : undefined,
}));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    rpcQuery: (proc: string, input: unknown) => ({
      queryKey: [proc, input],
      queryFn: () => state.rpc(proc, input),
    }),
  };
});

import { useDozoChatId } from "./dozo-chat-target";
import { queryClient } from "./query";

vi.mock("../components/thread/thread-screen", () => ({
  Thread: ({ userId }: { userId: string }) => {
    const chat = useDozoChatId();
    useEffect(() => {
      state.mounts.push(chat);
    }, [chat]);
    return createElement("main", null, `thread:${userId}:${chat ?? "main"}`);
  },
}));

import ThreadRoute from "../app/thread";

let root: Root;
let container: HTMLDivElement;
const chats = (...ids: { id: string; archived?: boolean }[]) => ({
  chats: ids.map(({ id, archived }) => ({
    id,
    botId: "bot-1",
    name: id,
    createdAt: "2026-11-21T10:00:00.000Z",
    archivedAt: archived ? "2026-11-21T11:00:00.000Z" : null,
    unread: false,
    snoozedUntil: null,
  })),
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = { botId: "bot-1" };
  state.inboxThread = undefined;
  state.mounts = [];
  state.rpc.mockReset();
  state.rpc.mockResolvedValue(chats());
  queryClient.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(ThreadRoute)));

// The route holds one chat for as long as it shows it, taken from its own parameters.
it("shows a bot's main chat with no request of its own", async () => {
  await render();
  expect(container.textContent).toBe("thread:user-1:main");
  expect(state.rpc).not.toHaveBeenCalled();
});

it("shows the extra chat the app named, without asking which one it is", async () => {
  state.params = { botId: "bot-1", chatId: "chat-1", name: "Ada" };
  await render();
  expect(container.textContent).toBe("thread:user-1:chat-1");
  expect(state.rpc).not.toHaveBeenCalled();
});

it("opens the main chat for a notification about it, as the inbox knows its thread", async () => {
  state.params = { botId: "bot-1", threadId: "thread-main" };
  state.inboxThread = "thread-main";
  await render();
  expect(container.textContent).toBe("thread:user-1:main");
  expect(state.rpc).not.toHaveBeenCalled();
});

it("opens the extra chat a notification names, once the bot's chat list says it is one", async () => {
  state.params = { botId: "bot-1", threadId: "chat-1" };
  state.inboxThread = "thread-main";
  let release: (value: unknown) => void = () => {};
  state.rpc.mockReturnValue(new Promise((resolve) => (release = resolve)));
  await render();
  // Nothing opens while the one read is out, so no chat is read, marked or suppressed by mistake.
  expect(container.querySelector("progress")).not.toBeNull();
  expect(container.textContent).not.toContain("thread:");
  await act(async () => release(chats({ id: "chat-1" })));
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:chat-1"));
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("dozoChats/list", { botId: "bot-1" });
});

it("opens the main chat for a notification about a chat that is archived or not the bot's", async () => {
  state.params = { botId: "bot-1", threadId: "chat-old" };
  state.rpc.mockResolvedValue(chats({ id: "chat-old", archived: true }, { id: "chat-2" }));
  await render();
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:main"));
});

it("opens the main chat when the chat list cannot be read", async () => {
  state.params = { botId: "bot-1", threadId: "chat-1" };
  state.rpc.mockRejectedValue(new Error("offline"));
  await render();
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:main"));
});

it("starts the screen over when a notification points the route at another chat", async () => {
  state.params = { botId: "bot-1", chatId: "chat-1" };
  await render();
  state.params = { botId: "bot-1", threadId: "thread-main" };
  state.inboxThread = "thread-main";
  await render();
  expect(container.textContent).toBe("thread:user-1:main");
  expect(state.mounts).toEqual(["chat-1", undefined]);
});

it("treats a group's route as no extra chat", async () => {
  state.params = { groupId: "group-1" };
  await render();
  expect(container.textContent).toBe("thread:user-1:main");
  expect(state.rpc).not.toHaveBeenCalled();
});
