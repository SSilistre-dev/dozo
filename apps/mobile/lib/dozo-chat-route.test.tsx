// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  inboxThread: undefined as string | undefined,
  // The bot's main chat saved on the phone, by its saved-copy target (`bot:<id>`).
  saved: {} as Record<string, { threadId: string }>,
  rpc: vi.fn(),
  // The bot's main thread as the server names it (threads/head).
  head: vi.fn(),
  scope: vi.fn(),
  replace: vi.fn(),
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
  useRouter: () => ({ replace: state.replace }),
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
vi.mock("./saved-chats", () => ({
  savedChatsScope: () => state.scope(),
  readSavedThread: (_scope: unknown, target: string) => state.saved[target] ?? null,
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
      queryFn: () => (proc === "threads/head" ? state.head(input) : state.rpc(proc, input)),
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
  state.saved = {};
  state.mounts = [];
  state.replace.mockReset();
  state.rpc.mockReset();
  state.head.mockReset();
  state.head.mockResolvedValue({ threadId: "thread-main", cursor: 0 });
  state.scope.mockReset();
  state.scope.mockResolvedValue({ namespace: "ns" });
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
  const list = deferred<ReturnType<typeof chats>>();
  state.rpc.mockReturnValue(list.promise);
  await render();
  // Nothing opens while the one read is out, so no chat is read, marked or suppressed by mistake.
  expect(container.querySelector("progress")).not.toBeNull();
  expect(container.textContent).not.toContain("thread:");
  await act(async () => list.resolve(chats({ id: "chat-1" })));
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:chat-1"));
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("dozoChats/list", { botId: "bot-1" });
});

it("shows the profile, not the main chat, for a notification about an archived chat when the main thread is unknown", async () => {
  state.params = { botId: "bot-1", threadId: "chat-old" };
  state.rpc.mockResolvedValue(chats({ id: "chat-old", archived: true }, { id: "chat-2" }));
  await render();
  await vi.waitFor(() => expect(state.replace).toHaveBeenCalledExactlyOnceWith(profileOf("bot-1")));
  expect(state.head).toHaveBeenCalledExactlyOnceWith({ botId: "bot-1" });
  expect(container.textContent).not.toContain("thread:");
});

// A notification names its thread only. The main chat opens at once when the phone knows which
// thread is the bot's main one and it is that one; any other thread needs the bot's chat list, and
// until the list answers nothing opens, so no chat is read, marked or suppressed by mistake.
const profileOf = (botId: string, name?: string) => ({
  pathname: "/bot-profile",
  params: { botId, ...(name ? { name } : {}) },
});

it("opens the main chat at once from its saved copy on a cold start, asking for nothing", async () => {
  state.params = { botId: "bot-1", threadId: "thread-main" };
  state.saved = { "bot:bot-1": { threadId: "thread-main" } };
  // Offline, the list would never answer: a bot with no extra chats must not wait for it.
  state.rpc.mockReturnValue(deferred().promise);
  await render();
  expect(container.textContent).toBe("thread:user-1:main");
  expect(state.rpc).not.toHaveBeenCalled();
});

it("waits for the list, not the main chat, when the saved copy is another thread", async () => {
  state.params = { botId: "bot-1", threadId: "chat-1" };
  state.saved = { "bot:bot-1": { threadId: "thread-main" } };
  const list = deferred<ReturnType<typeof chats>>();
  state.rpc.mockReturnValue(list.promise);
  await render();
  expect(container.querySelector("progress")).not.toBeNull();
  expect(container.textContent).not.toContain("thread:");
  await act(async () => list.resolve(chats({ id: "chat-1" })));
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:chat-1"));
});

it("opens the main chat when nothing is known, the list names no such chat and the server says it is the main thread", async () => {
  state.params = { botId: "bot-1", threadId: "thread-main" };
  const list = deferred<ReturnType<typeof chats>>();
  state.rpc.mockReturnValue(list.promise);
  await render();
  expect(container.textContent).not.toContain("thread:");
  await act(async () => list.resolve(chats({ id: "chat-1" })));
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:main"));
});

it.each([
  ["the inbox", () => (state.inboxThread = "thread-main")],
  ["the saved copy", () => (state.saved = { "bot:bot-1": { threadId: "thread-main" } })],
  ["nothing", () => undefined],
])(
  "shows no chat but the bot's profile when the list cannot be read (main thread known from %s)",
  async (_known, know) => {
    state.params = { botId: "bot-1", threadId: "chat-1", name: "Ada" };
    know();
    state.rpc.mockRejectedValue(new Error("offline"));
    await render();
    await vi.waitFor(() =>
      expect(state.replace).toHaveBeenCalledExactlyOnceWith(profileOf("bot-1", "Ada")),
    );
    expect(container.textContent).not.toContain("thread:");
  },
);

it("shows the profile, not the main chat, for a thread that is not the main one and not open", async () => {
  state.params = { botId: "bot-1", threadId: "chat-old" };
  state.inboxThread = "thread-main";
  state.rpc.mockResolvedValue(chats({ id: "chat-old", archived: true }));
  await render();
  await vi.waitFor(() => expect(state.replace).toHaveBeenCalledExactlyOnceWith(profileOf("bot-1")));
  expect(container.textContent).not.toContain("thread:");
});

it("shows the chat list's profile only for a notification, never for a chat the app named", async () => {
  state.params = { botId: "bot-1", chatId: "chat-1" };
  state.rpc.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.textContent).toBe("thread:user-1:chat-1");
  expect(state.replace).not.toHaveBeenCalled();
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

it("shows the profile when the server cannot say which thread is the main one", async () => {
  state.params = { botId: "bot-1", threadId: "chat-old" };
  state.head.mockRejectedValue(new Error("offline"));
  await render();
  await vi.waitFor(() => expect(state.replace).toHaveBeenCalledExactlyOnceWith(profileOf("bot-1")));
  expect(container.textContent).not.toContain("thread:");
});

it("waits for a fresh chat list when a stale one is cached, and opens the chat it names", async () => {
  state.params = { botId: "bot-1", threadId: "chat-new" };
  state.inboxThread = "thread-main";
  // Cached before the app went to the background: it does not name the new chat yet.
  queryClient.setQueryData(["dozoChats/list", { botId: "bot-1" }], chats({ id: "chat-1" }), {
    updatedAt: Date.now() - 60_000,
  });
  const list = deferred<ReturnType<typeof chats>>();
  state.rpc.mockReturnValue(list.promise);
  await render();
  expect(container.querySelector("progress")).not.toBeNull();
  expect(state.replace).not.toHaveBeenCalled();
  await act(async () => list.resolve(chats({ id: "chat-1" }, { id: "chat-new" })));
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:chat-new"));
  expect(state.replace).not.toHaveBeenCalled();
});

it("keeps the chat open when the list is read again after it opened", async () => {
  state.params = { botId: "bot-1", threadId: "chat-1" };
  state.inboxThread = "thread-main";
  state.rpc.mockResolvedValue(chats({ id: "chat-1" }));
  await render();
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:chat-1"));
  const again = deferred<ReturnType<typeof chats>>();
  state.rpc.mockReturnValue(again.promise);
  await act(async () => {
    void queryClient.invalidateQueries();
  });
  expect(container.textContent).toBe("thread:user-1:chat-1");
  expect(state.mounts).toEqual(["chat-1"]);
});

it("does not wait forever when the saved copy cannot be read", async () => {
  state.params = { botId: "bot-1", threadId: "thread-main" };
  state.scope.mockRejectedValue(new Error("storage"));
  await render();
  // No saved copy: the list and the server's main thread settle it.
  await vi.waitFor(() => expect(container.textContent).toBe("thread:user-1:main"));
  expect(container.querySelector("progress")).toBeNull();
});
