import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DozoExtraChatUnsupportedError,
  dozoChatThreadId,
  dozoMainChatOnly,
  dozoRefuseChatOnGroup,
  isDozoExtraChat,
} from "./dozo-chat-target.js";

const actor = { userId: "me", spaceId: "space-1" } as Actor;
const db = (rows: unknown[]) => ({ $queryRaw: vi.fn(async () => rows) });

describe("which chat of a bot a request names", () => {
  it("is the main chat without a chat id, or with the main chat's own", async () => {
    const none = db([]);
    expect(await dozoChatThreadId(none as never, actor, "bot-1", "main", undefined)).toBe("main");
    expect(await dozoChatThreadId(none as never, actor, "bot-1", "main", "main")).toBe("main");
    expect(none.$queryRaw).not.toHaveBeenCalled();
  });

  it("is the bot's extra chat in the caller's Space, or not found, never the main chat", async () => {
    const found = db([{ threadId: "chat-1" }]);
    expect(await dozoChatThreadId(found as never, actor, "bot-1", "main", "chat-1")).toBe("chat-1");
    const values = found.$queryRaw.mock.calls[0]!.slice(1);
    expect(values).toEqual(["chat-1", "bot-1", "space-1"]);
    await expect(
      dozoChatThreadId(db([]) as never, actor, "bot-1", "main", "chat-9"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("is never a group's", () => {
    expect(() => dozoRefuseChatOnGroup({ chatId: "chat-1" })).toThrow(IsolationError);
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
