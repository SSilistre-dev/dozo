// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMessage } from "./mobile-types";

const state = vi.hoisted(() => ({ rpc: vi.fn(), dismiss: vi.fn(async () => {}) }));

vi.mock("expo-router", () => ({ useNavigation: () => ({ isFocused: () => true }) }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active" },
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./live-notifications", () => ({ dismissThreadNotifications: state.dismiss }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

import { useThreadRead } from "./thread-read";

type Props = { botId?: string; groupId?: string; chatId?: string };
let root: Root;
const reads: Record<string, ReturnType<typeof useThreadRead>> = {};

function Probe({ name, ...props }: Props & { name: string }) {
  reads[name] = useThreadRead({ ...props, focused: true, readOnly: false });
  return null;
}
const render = (name: string, props: Props) =>
  act(() => root.render(createElement(Probe, { name, ...props })));
const flush = () => act(async () => {});
const message = { id: "message-1" } as MobileMessage;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ unreadAfterSeq: null });
  state.dismiss.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

// A bot's extra chat and its main chat are two chats: reading one never reads the other.
it("marks an open extra chat read as that chat, never as the bot's main chat", async () => {
  render("chat", { botId: "bot-1", chatId: "chat-1" });
  expect(reads.chat!.threadKey).toBe("chat-1");
  act(() => reads.chat!.markReadIfVisible());
  await flush();
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("threads/markRead", {
    chatBotId: "bot-1",
    chatId: "chat-1",
  });
  expect(reads.chat!.readVisibleTarget.current).toBe("chat-1");
});

it("marks an extra chat unread from a message as that chat", async () => {
  render("chat", { botId: "bot-1", chatId: "chat-1" });
  act(() => reads.chat!.markUnreadFrom(message));
  await flush();
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("threads/markUnread", {
    chatBotId: "bot-1",
    chatId: "chat-1",
    messageId: "message-1",
  });
  expect(reads.chat!.markedUnreadMessageId).toBe("message-1");
});

it("reads a bot's main chat and a group as before", async () => {
  render("main", { botId: "bot-1" });
  expect(reads.main!.threadKey).toBe("bot-1");
  act(() => reads.main!.markReadIfVisible());
  await flush();
  expect(state.rpc).toHaveBeenLastCalledWith("threads/markRead", { botId: "bot-1" });
  render("group", { groupId: "group-1" });
  expect(reads.group!.threadKey).toBe("group-1");
  act(() => reads.group!.markReadIfVisible());
  await flush();
  expect(state.rpc).toHaveBeenLastCalledWith("threads/markRead", { groupId: "group-1" });
});

it("starts a new visit when the same bot's other chat is opened", async () => {
  render("one", { botId: "bot-1" });
  const visit = reads.one!.readVisit.current.visit;
  act(() => reads.one!.markReadIfVisible());
  await flush();
  render("one", { botId: "bot-1", chatId: "chat-1" });
  expect(reads.one!.readVisit.current.visit).toBe(visit + 1);
  // What the main chat had read is not what this chat has.
  expect(reads.one!.readVisibleTarget.current).toBeNull();
});
