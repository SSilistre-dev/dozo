// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  DozoChatContext,
  dozoAvatarFeedKey,
  dozoChatIdentity,
  dozoChatKey,
  dozoChatParam,
  dozoChatTarget,
  dozoConsentBody,
  dozoDraftKey,
  dozoHelperTarget,
  dozoIsChatBody,
  dozoSavedChatTarget,
  dozoSnapshotIs,
  useDozoChatId,
} from "./dozo-chat-target";

// A request names exactly one chat: the bot's main chat, a group's, or an extra chat as chatBotId
// with chatId, never as botId (an older API would drop chatId and act on the main chat).
it("names a bot's main chat, a group and an extra chat as the contract has them", () => {
  expect(dozoChatTarget({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
  expect(dozoChatTarget({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
  expect(dozoChatTarget({ botId: "bot-1", chatId: "chat-1" })).toEqual({
    chatBotId: "bot-1",
    chatId: "chat-1",
  });
  // The extra chat's request never carries botId.
  expect(dozoChatTarget({ botId: "bot-1", chatId: "chat-1" })).not.toHaveProperty("botId");
});

it("lets a group win and sends what the screens always sent when nothing is named", () => {
  expect(dozoChatTarget({ botId: "bot-1", groupId: "group-1", chatId: "chat-1" })).toEqual({
    groupId: "group-1",
  });
  // A chat id with no bot is not an extra chat's target.
  expect(dozoChatTarget({ chatId: "chat-1" })).toEqual({ botId: undefined });
});

it("keeps one chat's state apart from every other's", () => {
  expect(dozoChatKey({ botId: "bot-1" })).toBe("bot-1");
  expect(dozoChatKey({ botId: "bot-1", chatId: "chat-1" })).toBe("chat-1");
  expect(dozoChatKey({ groupId: "group-1" })).toBe("group-1");
  expect(dozoChatKey({})).toBeUndefined();
  expect(dozoDraftKey("bot:bot-1", undefined)).toBe("bot:bot-1");
  expect(dozoDraftKey("bot:bot-1", "chat-1")).toBe("bot:bot-1:chat:chat-1");
});

it("tells where a chat is as a screen knows it, and as a saved copy is named", () => {
  expect(dozoChatIdentity({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
  expect(dozoChatIdentity({ botId: "bot-1", chatId: "chat-1" })).toEqual({
    botId: "bot-1",
    chatId: "chat-1",
  });
  expect(dozoChatIdentity({ botId: "bot-1", groupId: "group-1" })).toEqual({ groupId: "group-1" });
  expect(dozoSavedChatTarget({ botId: "bot-1" })).toBe("bot:bot-1");
  expect(dozoSavedChatTarget({ botId: "bot-1", chatId: "chat-1" })).toBe("chat:chat-1");
  expect(dozoSavedChatTarget({ groupId: "group-1" })).toBe("group:group-1");
});

it("holds a snapshot to the chat its saved file names", () => {
  expect(dozoSnapshotIs({ botId: "bot-1", threadId: "t-main" }, "bot:bot-1")).toBe(true);
  expect(dozoSnapshotIs({ botId: "bot-2", threadId: "t-2" }, "bot:bot-1")).toBe(false);
  expect(dozoSnapshotIs({ groupId: "group-1" }, "group:group-1")).toBe(true);
  // An extra chat's snapshot carries its bot, so only its own thread is that chat.
  expect(dozoSnapshotIs({ botId: "bot-1", threadId: "chat-1" }, "chat:chat-1")).toBe(true);
  expect(dozoSnapshotIs({ botId: "bot-1", threadId: "t-main" }, "chat:chat-1")).toBe(false);
});

it("reads a route's chat parameter once, trimmed", () => {
  expect(dozoChatParam("chat-1")).toBe("chat-1");
  expect(dozoChatParam(" chat-1 ")).toBe("chat-1");
  expect(dozoChatParam(["chat-1"])).toBe("chat-1");
  expect(dozoChatParam(["a", "b"])).toBeUndefined();
  expect(dozoChatParam("  ")).toBeUndefined();
  expect(dozoChatParam(undefined)).toBeUndefined();
});

it("reads a request body as the consent check and the avatar need it", () => {
  expect(dozoIsChatBody({ chatBotId: "bot-1", chatId: "chat-1" })).toBe(true);
  expect(dozoIsChatBody({ botId: "bot-1" })).toBe(false);
  expect(dozoIsChatBody(undefined)).toBe(false);
  expect(dozoConsentBody({ chatBotId: "bot-1", chatId: "chat-1", text: "hi" })).toEqual({
    chatBotId: "bot-1",
    chatId: "chat-1",
    text: "hi",
    botId: "bot-1",
  });
  const main = { botId: "bot-1" };
  expect(dozoConsentBody(main)).toBe(main);
  expect(dozoConsentBody(undefined)).toBeUndefined();
  expect(dozoAvatarFeedKey({ botId: "bot-1" })).toBe("bot:bot-1");
  expect(dozoAvatarFeedKey({ groupId: "group-1" })).toBe("group:group-1");
  expect(dozoAvatarFeedKey({ chatBotId: "bot-1", chatId: "chat-1" })).toBe("chat:chat-1");
});

it("names the chat a helper's Stop is for", () => {
  const helper = { botId: "bot-1", messageId: "message-1" };
  expect(dozoHelperTarget(helper, undefined)).toBe(helper);
  expect(dozoHelperTarget(helper, "chat-1")).toEqual({
    chatBotId: "bot-1",
    chatId: "chat-1",
    messageId: "message-1",
  });
});

it("gives each route its own chat, none by default", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: (string | undefined)[] = [];
  function Probe() {
    seen.push(useDozoChatId());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () =>
    root.render(createElement(DozoChatContext.Provider, { value: "chat-1" }, createElement(Probe))),
  );
  expect(seen).toEqual([undefined, "chat-1"]);
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
