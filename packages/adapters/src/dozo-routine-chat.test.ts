import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import type * as Logging from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createThreadMessageInTransaction: vi.fn(),
  appendEventInTransaction: vi.fn(),
}));
const logged = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  ...db,
}));
vi.mock("@rakazo/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof Logging>()),
  getLogger: () => ({ error: logged }),
}));

import {
  dozoNoteRoutineChat,
  dozoOpenRoutineChat,
  dozoRoutineChatNote,
  dozoRoutineThread,
} from "./dozo-routine-chat.js";

const MAIN = { id: "main-1" };
const ARCHIVED_AT = new Date("2026-11-21T08:00:00.000Z");
const bot = { id: "bot-1", thread: MAIN };

/** A database whose dozo_bot_chats holds `chats`, by thread. */
function fakeDb(
  chats: Record<string, { botId: string; spaceId: string; name: string; archived: boolean }>,
) {
  const $queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [threadId, botId, spaceId] = values as [string, string, string];
    const chat = chats[threadId];
    return chat && chat.botId === botId && chat.spaceId === spaceId
      ? [
          {
            name: chat.name,
            archived: chat.archived,
            archivedAt: chat.archived ? ARCHIVED_AT : null,
          },
        ]
      : [];
  });
  return { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw"> & {
    $queryRaw: typeof $queryRaw;
  };
}

const chats = {
  "chat-1": { botId: "bot-1", spaceId: "space-1", name: "Garden", archived: false },
  "chat-old": { botId: "bot-1", spaceId: "space-1", name: "Old", archived: true },
  "chat-9": { botId: "bot-2", spaceId: "space-1", name: "Trails", archived: false },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("where a routine's run posts", () => {
  it("keeps the thread upstream found, and the main chat without a chat, reading nothing", async () => {
    const prisma = fakeDb(chats);
    const group = { id: "group-thread" };
    const routine = { threadId: "group-thread", spaceId: "space-1" };
    expect(await dozoRoutineThread({ prisma }, routine, bot, group)).toBe(group);
    expect(await dozoRoutineThread({ prisma }, { ...routine, threadId: null }, bot, null)).toEqual(
      MAIN,
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("posts in the bot's open extra chat", async () => {
    const prisma = fakeDb(chats);
    const routine = { threadId: "chat-1", spaceId: "space-1" };
    expect(await dozoRoutineThread({ prisma }, routine, bot, null)).toEqual({ id: "chat-1" });
  });

  it("stands in the main chat for an archived chat, naming it", async () => {
    const prisma = fakeDb(chats);
    const routine = { threadId: "chat-old", spaceId: "space-1" };
    expect(await dozoRoutineThread({ prisma }, routine, bot, null)).toEqual({
      id: "main-1",
      dozoArchivedChat: { chatId: "chat-old", name: "Old", archivedAt: ARCHIVED_AT },
    });
  });

  it("never posts in another bot's or another Space's chat", async () => {
    const prisma = fakeDb(chats);
    for (const routine of [
      { threadId: "chat-9", spaceId: "space-1" },
      { threadId: "chat-1", spaceId: "space-2" },
      { threadId: "gone", spaceId: "space-1" },
    ])
      expect(await dozoRoutineThread({ prisma }, routine, bot, null)).toEqual(MAIN);
  });

  it("lets a retry or a test run use an open extra chat of the bot only", async () => {
    const prisma = fakeDb(chats);
    const of = (threadId: string | null, botId = "bot-1") =>
      dozoOpenRoutineChat(prisma, { threadId, botId, spaceId: "space-1" });
    expect(await of("chat-1")).toBe(true);
    expect(await of("chat-old")).toBe(false);
    expect(await of("chat-9")).toBe(false);
    expect(await of("chat-1", "bot-2")).toBe(false);
    expect(await of(null)).toBe(false);
  });
});

describe("the note for a routine whose chat is archived", () => {
  const events = { notify: vi.fn(async () => undefined) };
  const routine = { id: "routine-1", name: "Digest", spaceId: "space-1", userId: "user-1" };
  const archived = { chatId: "chat-old", name: "Garden", archivedAt: ARCHIVED_AT };
  const thread = { id: "main-1", dozoArchivedChat: archived };
  const nonce = `dozo-routine-chat:routine-1:chat-old:${ARCHIVED_AT.getTime()}`;
  /** A transaction that finds the note already written when `written`, and the owner's locale. */
  function prismaWith(written: boolean, locale: string | null = "en") {
    const tx = {
      message: { findUnique: vi.fn(async () => (written ? { id: "m-0" } : null)) },
      user: { findUnique: vi.fn(async () => ({ locale })) },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
    } as unknown as PrismaClient;
    return { prisma, tx };
  }

  it("says nothing for a run in the chat it was meant for", async () => {
    const { prisma } = prismaWith(false);
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", { id: "chat-1" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("writes one system line in the main chat, keyed by the routine and the archiving, and signals it", async () => {
    db.createThreadMessageInTransaction.mockResolvedValue({ id: "m-1" });
    db.appendEventInTransaction.mockResolvedValue({ seq: 7 });
    const { prisma, tx } = prismaWith(false);
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", thread);
    const blocks = [{ kind: "meta", text: "Digest posts here while its chat Garden is archived." }];
    expect(tx.message.findUnique).toHaveBeenCalledWith({
      where: { threadId_clientNonce: { threadId: "main-1", clientNonce: nonce } },
      select: { id: true },
    });
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { locale: true },
    });
    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(tx, {
      threadId: "main-1",
      botId: "bot-1",
      role: "system",
      blocks,
      clientNonce: nonce,
    });
    expect(db.appendEventInTransaction).toHaveBeenCalledWith(tx, {
      spaceId: "space-1",
      threadId: "main-1",
      botId: "bot-1",
      type: "thread.message.created",
      payload: { messageId: "m-1", role: "system", blocks },
    });
    expect(events.notify).toHaveBeenCalledWith("main-1", 7);
  });

  it("writes nothing again for the same archiving, however often the routine wakes", async () => {
    const { prisma } = prismaWith(true);
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", thread);
    expect(db.createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(events.notify).not.toHaveBeenCalled();
  });

  it("says it in the owner's language", async () => {
    expect(dozoRoutineChatNote("Özet", "Bahçe", "tr-TR")).toBe(
      "Özet, sohbeti Bahçe arşivliyken buraya yazar.",
    );
    expect(dozoRoutineChatNote("Digest", "Garden", null)).toBe(
      "Digest posts here while its chat Garden is archived.",
    );
    db.createThreadMessageInTransaction.mockResolvedValue({ id: "m-1" });
    db.appendEventInTransaction.mockResolvedValue({ seq: 7 });
    const { prisma } = prismaWith(false, "tr");
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", {
      id: "main-1",
      dozoArchivedChat: { ...archived, archivedAt: null },
    });
    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(expect.anything(), {
      threadId: "main-1",
      botId: "bot-1",
      role: "system",
      blocks: [{ kind: "meta", text: "Digest, sohbeti Garden arşivliyken buraya yazar." }],
      clientNonce: "dozo-routine-chat:routine-1:chat-old:0",
    });
  });

  it("leaves a note a racing wake wrote alone, and logs any other failure without failing the wake", async () => {
    const { prisma } = prismaWith(false);
    db.createThreadMessageInTransaction.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: "P2002" }),
    );
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", thread);
    expect(logged).not.toHaveBeenCalled();
    db.createThreadMessageInTransaction.mockRejectedValueOnce(new Error("database down"));
    await dozoNoteRoutineChat({ prisma, events }, routine, "bot-1", thread);
    expect(logged).toHaveBeenCalledWith("dozo.routine_chat_note_failed", expect.any(Error));
    expect(events.notify).not.toHaveBeenCalled();
  });
});
