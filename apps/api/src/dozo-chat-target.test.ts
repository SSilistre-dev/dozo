import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DozoExtraChatUnsupportedError,
  dozoBotOrGroupOnly,
  dozoChatThreadId,
  dozoMainChatOnly,
  dozoRefuseChatOnGroup,
  isDozoExtraChat,
} from "./dozo-chat-target.js";

const actor = { userId: "me", spaceId: "space-1" } as Actor;
const db = (rows: unknown[]) => ({ $queryRaw: vi.fn(async () => rows) });

describe("which chat of a bot a request names", () => {
  it("is the main chat for botId, or for chatBotId with the main chat's own id", async () => {
    const none = db([]);
    expect(await dozoChatThreadId(none as never, actor, "bot-1", "main", {})).toBe("main");
    expect(
      await dozoChatThreadId(none as never, actor, "bot-1", "main", {
        chatBotId: "bot-1",
        chatId: "main",
      }),
    ).toBe("main");
    expect(none.$queryRaw).not.toHaveBeenCalled();
  });

  it("is the bot's open extra chat in the caller's Space, or not found, never the main chat", async () => {
    const found = db([{ threadId: "chat-1" }]);
    const named = { chatBotId: "bot-1", chatId: "chat-1" };
    expect(await dozoChatThreadId(found as never, actor, "bot-1", "main", named)).toBe("chat-1");
    expect(found.$queryRaw.mock.calls[0]!.slice(1)).toEqual(["chat-1", "bot-1", "space-1", false]);
    await dozoChatThreadId(found as never, actor, "bot-1", "main", named, {
      includeArchived: true,
    });
    expect(found.$queryRaw.mock.calls[1]!.slice(1)).toEqual(["chat-1", "bot-1", "space-1", true]);
    await expect(
      dozoChatThreadId(db([]) as never, actor, "bot-1", "main", named),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("refuses a chat id beside botId, and chatBotId without a chat", async () => {
    const none = db([{ threadId: "chat-1" }]);
    await expect(
      dozoChatThreadId(none as never, actor, "bot-1", "main", { chatId: "chat-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      dozoChatThreadId(none as never, actor, "bot-1", "main", { chatBotId: "bot-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(none.$queryRaw).not.toHaveBeenCalled();
  });

  it("is never a group's", () => {
    expect(() => dozoRefuseChatOnGroup({ chatId: "chat-1" })).toThrow(IsolationError);
    expect(() => dozoRefuseChatOnGroup({ chatBotId: "bot-1" })).toThrow(IsolationError);
    expect(() => dozoRefuseChatOnGroup({})).not.toThrow();
  });
});

describe("what only a bot's main chat does", () => {
  const bot = { thread: { id: "main" } };
  it("refuses an extra chat with a stable code and lets the main chat and groups through", () => {
    expect(isDozoExtraChat({ kind: "bot", threadId: "chat-1", bot })).toBe(true);
    expect(isDozoExtraChat({ kind: "bot", threadId: "main", bot })).toBe(false);
    expect(isDozoExtraChat({ kind: "group", threadId: "g" })).toBe(false);
    expect(() =>
      dozoMainChatOnly({ kind: "bot", threadId: "chat-1", bot }, "Clearing a chat"),
    ).toThrow(DozoExtraChatUnsupportedError);
    try {
      dozoMainChatOnly({ kind: "bot", threadId: "chat-1", bot }, "Clearing a chat");
    } catch (error) {
      expect(error).toMatchObject({
        kind: "BAD_REQUEST",
        code: "dozo_extra_chat_unsupported",
        message: "Clearing a chat works in a bot's main chat only.",
      });
    }
    expect(() => dozoMainChatOnly({ kind: "bot", threadId: "main", bot }, "x")).not.toThrow();
  });
});

describe("a route that reads its bot or group itself", () => {
  it("refuses a bot's extra chat, and takes a bot or a group", () => {
    for (const input of [
      { chatBotId: "bot-1", chatId: "c" },
      { chatId: "c" },
      { chatBotId: "b" },
    ]) {
      expect(() => dozoBotOrGroupOnly(input)).toThrow(
        expect.objectContaining({ kind: "BAD_REQUEST", code: "dozo_extra_chat_not_a_target" }),
      );
    }
    const input = {};
    expect(dozoBotOrGroupOnly(input)).toBe(input);
  });
});
