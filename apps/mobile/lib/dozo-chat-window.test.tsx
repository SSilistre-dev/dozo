// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api/mobile-types";
import type { ThreadListScroll } from "./thread/scroll/thread-list-scroll";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  subscribe: vi.fn(),
  writeSaved: vi.fn(),
  readSaved: vi.fn(() => null as unknown),
  refreshed: vi.fn(),
}));

vi.mock("expo-router", () => ({ useFocusEffect: () => undefined }));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api", () => ({ rpc: state.rpc, selectedSpaceId: () => "space-1" }));
vi.mock("./api/api-live", () => ({ subscribeThread: state.subscribe }));
vi.mock("./thread/conversation-cleared", () => ({ onConversationCleared: () => () => undefined }));
vi.mock("./integrations-cache", () => ({ isIntegrationsScopeCurrent: () => true }));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./native/haptics", () => ({ getHapticsEnabled: () => false, hapticSuccess: vi.fn() }));
vi.mock("./api/user-error", () => ({ errorText: (_: unknown, fallback = "error") => fallback }));
vi.mock("./preferences/response-streaming", () => ({
  getCachedResponseStreamingEnabled: () => false,
  subscribeResponseStreaming: () => () => {},
}));
const scope = { sessionGeneration: 1, selectionId: "space-1", namespace: "ns" };
vi.mock("./inbox/saved-chats", () => ({
  liveSavedChatsScope: async () => scope,
  savedChatsScope: async () => scope,
  savedChatTarget: () => "unused",
  readSavedThread: state.readSaved,
  writeSavedThread: state.writeSaved,
}));

import { useThreadSnapshot } from "./thread/thread-history";
import { useThreadPaging } from "./thread/thread-paging";
import { useThreadSync } from "./thread/thread-sync";

const snapshot = (overrides: Partial<MobileSnapshot>): MobileSnapshot =>
  ({
    threadId: "chat-1",
    botId: "bot-1",
    cursor: 5,
    olderCursor: 3,
    messages: [{ id: "m-1", role: "user", seq: 4, blocks: [{ kind: "text", text: "hi" }] }],
    run: null,
    ...overrides,
  }) as MobileSnapshot;

type Chat = { botId?: string; groupId?: string; chatId?: string };
let root: Root;
const probe = {} as {
  history: ReturnType<typeof useThreadSnapshot>;
  sync: ReturnType<typeof useThreadSync>;
  paging: ReturnType<typeof useThreadPaging>;
};
const ref = <T,>(current: T) => ({ current });

function Probe({ chat, foreground }: { chat: Chat; foreground: boolean }) {
  const history = useThreadSnapshot();
  const scroll = {
    behavior: { current: { state: () => ({}) } },
    setState: vi.fn(),
    pinnedNewerCursor: null,
    pinnedScrollBack: { current: {} },
  } as unknown as ThreadListScroll;
  const sync = useThreadSync({
    history,
    scroll,
    ...chat,
    readOnly: false,
    foreground,
    focused: true,
    sessionEpoch: 1,
    userId: "user-1",
    activeBotId: ref(chat.botId),
    activeGroupId: ref(chat.groupId),
    readVisibleTarget: ref(null),
    setExpandedPeerMarkers: vi.fn(),
    setError: vi.fn(),
    onRefreshed: state.refreshed,
    refreshMentionBots: async () => undefined,
    markReadIfVisible: vi.fn(),
  });
  const paging = useThreadPaging({
    history,
    scroll,
    ...chat,
    visibleMessages: [],
    anchor: 0,
    setError: vi.fn(),
    showLatest: vi.fn(),
  });
  probe.history = history;
  probe.sync = sync;
  probe.paging = paging;
  return null;
}

const mount = (chat: Chat, foreground = false) =>
  act(async () => root.render(createElement(Probe, { chat, foreground })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [
    state.rpc,
    state.subscribe,
    state.writeSaved,
    state.readSaved,
    state.refreshed,
  ])
    mock.mockReset();
  state.rpc.mockImplementation(async (proc: string) =>
    proc === "threads/messages"
      ? { threadId: "chat-1", messages: [], olderCursor: null, cursor: 5 }
      : snapshot({}),
  );
  state.subscribe.mockImplementation(
    async (_target: unknown, _cursor: number, _on: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  );
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const target = (proc: string) =>
  state.rpc.mock.calls.filter(([name]) => name === proc).map(([, body]) => body);

// Every read of the chat on screen names that chat: a request that named the bot would read the
// bot's main chat, which is another chat.
it("refreshes an extra chat as chatBotId and chatId and keeps its own saved copy", async () => {
  await mount({ botId: "bot-1", chatId: "chat-1" });
  await act(async () => void (await probe.sync.refresh()));
  expect(target("threads/get")).toEqual([{ chatBotId: "bot-1", chatId: "chat-1" }]);
  expect(state.writeSaved).toHaveBeenCalledWith(scope, "chat:chat-1", expect.anything());
  expect(probe.history.snap?.threadId).toBe("chat-1");
});

// The screen clears its failure line when the refresh it asked for is for the chat it holds, by
// the key its feedback is kept under: an extra chat's own id, else the group's or the bot's.
it("tells the screen a refresh of an extra chat is for that chat, by its own key", async () => {
  await mount({ botId: "bot-1", chatId: "chat-1" });
  await act(async () => void (await probe.sync.refresh()));
  expect(state.refreshed).toHaveBeenCalledExactlyOnceWith("chat-1");
});

it("tells the screen a refresh of a bot's main chat and of a group is for them, as before", async () => {
  await mount({ botId: "bot-1" });
  await act(async () => void (await probe.sync.refresh()));
  expect(state.refreshed).toHaveBeenLastCalledWith("bot-1");
  await act(async () =>
    root.render(createElement(Probe, { chat: { groupId: "group-1" }, foreground: false })),
  );
  state.rpc.mockResolvedValue(
    snapshot({ threadId: "thread-group", botId: undefined, groupId: "group-1" }),
  );
  await act(async () => void (await probe.sync.refresh()));
  expect(state.refreshed).toHaveBeenLastCalledWith("group-1");
});

it("keeps a bot's main chat and a group as before", async () => {
  await mount({ botId: "bot-1" });
  state.rpc.mockResolvedValue(snapshot({ threadId: "thread-main" }));
  await act(async () => void (await probe.sync.refresh()));
  expect(target("threads/get")).toEqual([{ botId: "bot-1" }]);
  expect(state.writeSaved).toHaveBeenCalledWith(scope, "bot:bot-1", expect.anything());
  await act(async () =>
    root.render(createElement(Probe, { chat: { groupId: "group-1" }, foreground: false })),
  );
  state.rpc.mockResolvedValue(
    snapshot({ threadId: "thread-group", botId: undefined, groupId: "group-1" }),
  );
  await act(async () => void (await probe.sync.refresh()));
  expect(target("threads/get").at(-1)).toEqual({ groupId: "group-1" });
});

it("subscribes to the extra chat and reads its head, not the bot's main chat", async () => {
  await mount({ botId: "bot-1", chatId: "chat-1" }, true);
  await act(async () => {});
  expect(state.subscribe).toHaveBeenCalled();
  expect(state.subscribe.mock.calls[0]![0]).toEqual({ chatBotId: "bot-1", chatId: "chat-1" });
  expect(target("threads/get")).toEqual([{ chatBotId: "bot-1", chatId: "chat-1" }]);
});

it("pages through the extra chat's own history", async () => {
  await mount({ botId: "bot-1", chatId: "chat-1" });
  await act(async () => void (await probe.sync.refresh()));
  await act(async () => void (await probe.paging.loadOlderMessages()));
  expect(target("threads/messages")).toEqual([
    { chatBotId: "bot-1", chatId: "chat-1", before: 3, includePeerReceipts: true },
  ]);
});

it("opens the page around a message in the chat it is in and pins that chat", async () => {
  await mount({ botId: "bot-1", chatId: "chat-1" });
  state.rpc.mockImplementation(async (proc: string) =>
    proc === "threads/messages"
      ? {
          threadId: "chat-1",
          messages: [{ id: "m-1", role: "user", seq: 4, blocks: [{ kind: "text", text: "hi" }] }],
          olderCursor: null,
          cursor: 5,
          coveredThroughSeq: 5,
        }
      : snapshot({}),
  );
  await act(
    async () =>
      void (await probe.sync.applyMessageJump({
        botId: "bot-1",
        chatId: "chat-1",
        messageId: "m-1",
      })),
  );
  expect(target("threads/get")).toEqual([{ chatBotId: "bot-1", chatId: "chat-1" }]);
  expect(target("threads/messages")).toEqual([
    { chatBotId: "bot-1", chatId: "chat-1", around: { messageId: "m-1" } },
  ]);
  expect(probe.history.pinnedAroundRef.current).toMatchObject({
    botId: "bot-1",
    chatId: "chat-1",
    messageId: "m-1",
  });
  expect(probe.history.pinnedAroundRef.current).not.toHaveProperty("chatBotId");
});

it("opens a search hit in a bot's main chat as before", async () => {
  await mount({ botId: "bot-1" });
  await act(
    async () => void (await probe.sync.applyMessageJump({ botId: "bot-1", messageId: "m-1" })),
  );
  expect(target("threads/get")).toEqual([{ botId: "bot-1" }]);
  expect(target("threads/messages")).toEqual([{ botId: "bot-1", around: { messageId: "m-1" } }]);
});
