import { afterEach, describe, expect, it } from "vitest";
import {
  dozoChatOf,
  dozoDraftKey,
  dozoExtraChatOpen,
  dozoOpenChat,
  setDozoOpenChat,
} from "./dozo-open-chat";

afterEach(() => setDozoOpenChat(null));

describe("the open extra chat", () => {
  it("is nothing on a main chat, and keeps the main chat's composer key", () => {
    expect(dozoOpenChat()).toBeNull();
    expect(dozoExtraChatOpen()).toBe(false);
    expect(dozoChatOf("bot-1")).toEqual({});
    expect(dozoDraftKey("bot:bot-1", "bot-1")).toBe("bot:bot-1");
  });

  it("gives each extra chat its own composer key, so a draft never moves between chats", () => {
    setDozoOpenChat({ botId: "bot-1", chatId: "chat-1" });
    expect(dozoOpenChat()).toEqual({ botId: "bot-1", chatId: "chat-1" });
    expect(dozoExtraChatOpen()).toBe(true);
    expect(dozoExtraChatOpen("bot-1")).toBe(true);
    expect(dozoExtraChatOpen("bot-2")).toBe(false);
    expect(dozoChatOf("bot-1")).toEqual({ chatId: "chat-1" });
    expect(dozoChatOf(undefined)).toEqual({});
    expect(dozoDraftKey("bot:bot-1", "bot-1")).toBe("bot:bot-1:chat:chat-1");
    // Another bot's key is its own.
    expect(dozoDraftKey("bot:bot-2", "bot-2")).toBe("bot:bot-2");
    expect(dozoDraftKey("bot:undefined", undefined)).toBe("bot:undefined");
  });
});
