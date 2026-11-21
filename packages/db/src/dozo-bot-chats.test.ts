import { describe, expect, it, vi } from "vitest";
import {
  dozoBotChatThreads,
  dozoChatBotId,
  dozoChatNoticeBot,
  dozoExportChat,
  dozoExportChats,
  withDozoChatBot,
} from "./dozo-bot-chats.js";

type Sql = { text: string; values: unknown[] };

/** Answers every raw read with `rows`, and records what was asked. */
function fakeDb(rows: unknown[] = []) {
  const asked: Sql[] = [];
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return rows;
    }),
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", name: "Chef" })) },
  };
  return { db, asked };
}

describe("the chat's bot", () => {
  it("is the extra chat's row's bot, or none", async () => {
    expect(await dozoChatBotId(fakeDb([{ botId: "bot-1" }]).db as never, "chat-1")).toBe("bot-1");
    expect(await dozoChatBotId(fakeDb().db as never, "chat-1")).toBeNull();
  });

  it("fills an extra chat's botId for reading, and leaves every other thread alone", async () => {
    const chat = fakeDb([{ botId: "bot-1" }]);
    expect(await withDozoChatBot(chat.db as never, "chat-1", { botId: null, n: 1 })).toEqual({
      botId: "bot-1",
      n: 1,
    });
    const nobody = fakeDb();
    const orphan = { botId: null };
    expect(await withDozoChatBot(nobody.db as never, "t", orphan)).toBe(orphan);
    for (const owned of [
      { botId: "bot-9" },
      { botId: null, groupId: "group-1" },
      { botId: null, externalConversationId: "x" },
      { botId: null, helperBotId: "bot-2" },
    ]) {
      const untouched = fakeDb([{ botId: "bot-1" }]);
      expect(await withDozoChatBot(untouched.db as never, "t", owned)).toBe(owned);
      expect(untouched.db.$queryRaw).not.toHaveBeenCalled();
    }
    expect(await withDozoChatBot(nobody.db as never, "t", null)).toBeNull();
  });

  it("names a notice's bot only for an extra chat", async () => {
    const chat = fakeDb([{ botId: "bot-1" }]);
    expect(await dozoChatNoticeBot(chat.db as never, "chat-1")).toEqual({
      id: "bot-1",
      name: "Chef",
    });
    expect(chat.db.bot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot-1" } }),
    );
    const none = fakeDb();
    expect(await dozoChatNoticeBot(none.db as never, "t")).toBeNull();
    expect(none.db.bot.findUnique).not.toHaveBeenCalled();
  });
});

describe("a bot's extra chats as threads", () => {
  it("are read in the Space, one of them when named", async () => {
    const { db, asked } = fakeDb([{ id: "chat-1" }]);
    expect(await dozoBotChatThreads(db as never, "space-1", "bot-1")).toEqual([
      { id: "chat-1", botId: "bot-1" },
    ]);
    expect(asked[0]?.values).toEqual(["space-1", "bot-1", null, null]);
    await dozoBotChatThreads(db as never, "space-1", "bot-1", "chat-1");
    expect(asked[1]?.values).toEqual(["space-1", "bot-1", "chat-1", "chat-1"]);
  });
});

describe("an account archive's extra chats", () => {
  it("keeps each chat's bot, name and archive time, by thread", async () => {
    const archivedAt = new Date("2026-11-20T10:00:00.000Z");
    const { db, asked } = fakeDb([
      { threadId: "chat-1", botId: "bot-1", name: "Garden", archivedAt: null },
      { threadId: "chat-2", botId: "bot-1", name: "Taxes", archivedAt },
    ]);
    const chats = await dozoExportChats(db as never, "space-1", ["bot-1"]);
    expect(asked[0]?.text).toContain("AT TIME ZONE 'UTC'");
    expect(dozoExportChat(chats, "chat-2")).toEqual({
      dozoChat: { botId: "bot-1", name: "Taxes", archivedAt: "2026-11-20T10:00:00.000Z" },
    });
    expect(dozoExportChat(chats, "chat-1")).toEqual({
      dozoChat: { botId: "bot-1", name: "Garden", archivedAt: null },
    });
    expect(dozoExportChat(chats, "main")).toEqual({});
    const none = fakeDb();
    expect((await dozoExportChats(none.db as never, "space-1", [])).size).toBe(0);
    expect(none.db.$queryRaw).not.toHaveBeenCalled();
  });
});
