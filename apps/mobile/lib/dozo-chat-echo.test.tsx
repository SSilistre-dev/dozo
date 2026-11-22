// @vitest-environment jsdom

import { resolveComposerSendPlan } from "@rakazo/core";
import { act, createElement, useMemo } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dozoEchoedSeqs } from "./dozo-chat-target";
import type { MobileSnapshot } from "./mobile-types";
import type { SendAttempt, SendPayload } from "./thread-feedback";
import {
  clearFailedSends,
  configureUnsentSends,
  restoreUnsentSends,
  useThreadFeedback,
} from "./thread-feedback";
import { useThreadRead } from "./thread-read";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active" },
}));
vi.mock("expo-router", () => ({ useNavigation: () => ({ isFocused: () => true }) }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(),
  dismissThreadNotifications: vi.fn(async () => {}),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));

type Chat = { botId?: string; groupId?: string; chatId?: string };

let root: Root;
let unsent = -1;
let nonces = 0;
const request = vi.fn();
const scope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  cacheSession: "ns-a",
  spaceId: "space-a",
};
const disk = {
  admit: vi.fn((_attempt: SendAttempt) => true),
  hydrate: vi.fn(async (_attempt: SendAttempt) => undefined),
  forget: vi.fn(),
  load: vi.fn((): SendAttempt[] => []),
  save: vi.fn(),
  clear: vi.fn(),
};
let feedback: ReturnType<typeof useThreadFeedback>;

/** What the chat screen does: its read hook's key, the echoes of its snapshot, its feedback. */
function Screen({ chat, snap }: { chat: Chat; snap?: MobileSnapshot }) {
  const { threadKey } = useThreadRead({ ...chat, focused: true, readOnly: false });
  const echoed = useMemo(() => (snap ? dozoEchoedSeqs(snap, chat) : undefined), [snap, chat]);
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`, echoed);
  unsent = feedback.unsentSends.length;
  return null;
}

const snapshot = (overrides: Partial<MobileSnapshot>): MobileSnapshot =>
  ({
    threadId: "chat-1",
    botId: "bot-1",
    cursor: 5,
    messages: [{ id: "m-1", role: "user", seq: 42, blocks: [{ kind: "text", text: "hi" }] }],
    run: null,
    ...overrides,
  }) as MobileSnapshot;

function payload(chat: Chat): SendPayload {
  return {
    originThreadKey: chat.chatId ?? chat.botId!,
    displayText: "hi",
    replyPreview: null,
    initialBotTarget: chat.botId,
    botTarget: chat.botId,
    ...(chat.chatId ? { chatId: chat.chatId } : {}),
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text: "hi", mentions: [], hasAttachments: false }),
    attachments: [],
    replyQuote: null,
  };
}

const render = (chat: Chat, snap?: MobileSnapshot) =>
  act(async () => root.render(createElement(Screen, { chat, snap })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearFailedSends();
  request.mockReset();
  request.mockResolvedValue({ seq: 42 });
  configureUnsentSends({
    request,
    scope: () => scope,
    serverReachable: () => true,
    passwordChanging: () => false,
    disk,
    errorText: (error) => (error instanceof Error ? error.message : String(error)),
    notDelivered: vi.fn(),
  });
  restoreUnsentSends();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  clearFailedSends();
  vi.unstubAllGlobals();
});

/** Sends one message from the chat on screen, as its composer does, and waits for the server. */
async function sendFrom(chat: Chat) {
  const attempt = feedback.sendAttempt(payload(chat));
  await act(async () => {
    await feedback.send(attempt);
  });
  return attempt;
}

// A send the server accepted waits for its message to come back on the chat's stream, then its
// bubble goes. The chat's key is its extra chat's id, so the echo must be found by that chat too.
it("takes down the unsent bubble of a message sent in an extra chat once the chat shows it", async () => {
  const chat = { botId: "bot-1", chatId: "chat-1" };
  await render(chat, snapshot({ messages: [] }));
  const attempt = await sendFrom(chat);
  expect(request).toHaveBeenCalledWith(
    "threads/send",
    expect.objectContaining({ chatBotId: "bot-1", chatId: "chat-1" }),
    undefined,
    "space-a",
  );
  expect(attempt.acceptedSeq).toBe(42);
  expect(unsent).toBe(1);
  await render(chat, snapshot({}));
  expect(unsent).toBe(0);
});

it("keeps the bubble while the chat on screen is another chat's snapshot", async () => {
  const chat = { botId: "bot-1", chatId: "chat-1" };
  await render(chat, snapshot({ messages: [] }));
  await sendFrom(chat);
  // The bot's main chat holds a message with the same seq: it is not this chat's echo.
  await render(chat, snapshot({ threadId: "thread-main" }));
  expect(unsent).toBe(1);
});

it("takes down a bot's main chat bubble and a group's as before", async () => {
  const main = { botId: "bot-1" };
  await render(main, snapshot({ threadId: "thread-main", messages: [] }));
  await sendFrom(main);
  expect(unsent).toBe(1);
  await render(main, snapshot({ threadId: "thread-main" }));
  expect(unsent).toBe(0);
  const group = { groupId: "group-1" };
  expect(dozoEchoedSeqs(snapshot({ botId: undefined, groupId: "group-1" }), group)).toEqual(
    new Set([42]),
  );
  expect(dozoEchoedSeqs(snapshot({ threadId: "thread-main" }), group)).toBeUndefined();
});

it("hears no echo from a snapshot of another bot", () => {
  expect(
    dozoEchoedSeqs(snapshot({ botId: "bot-2", threadId: "thread-2" }), { botId: "bot-1" }),
  ).toBe(undefined);
});
