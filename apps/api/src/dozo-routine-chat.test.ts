import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dozoMentionedRoutine } from "./dozo-routine-chat.js";

/** The Space's extra chats by thread, as dozo_bot_chats answers. */
function prismaWith(chats: Record<string, { botId: string; archived: boolean }>) {
  const prisma = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [threadId, botId, spaceId] = values as [string, string, string];
      const chat = chats[threadId];
      return chat && chat.botId === botId && spaceId === "space-1"
        ? [{ name: "Chat", archived: chat.archived, archivedAt: null }]
        : [];
    }),
  };
  return prisma as typeof prisma & Pick<PrismaClient, "$queryRaw">;
}

const actor = { spaceId: "space-1" };
// The routine posts in its own chat, "garden", on its own.
const target = { botId: "bot-1", threadId: "garden", dozoMainThreadId: "main", routine: "r" };
const chats = {
  garden: { botId: "bot-1", archived: false },
  notes: { botId: "bot-1", archived: false },
  old: { botId: "bot-1", archived: true },
  trails: { botId: "bot-2", archived: false },
};

describe("a routine named in a message", () => {
  it("runs in the extra chat the message was written in", async () => {
    const prisma = prismaWith(chats);
    const run = (chatId: string) =>
      dozoMentionedRoutine(prisma, actor, { chatBotId: "bot-1", chatId }, target);
    expect(await run("notes")).toEqual({ ...target, threadId: "notes" });
    expect(await run("garden")).toEqual({ ...target, threadId: "garden" });
  });

  it("runs in the bot's main chat for a message there, in a group or in another bot's chat", async () => {
    const prisma = prismaWith(chats);
    for (const message of [{}, { chatBotId: "bot-2", chatId: "trails" }, { chatBotId: "bot-1" }])
      expect(await dozoMentionedRoutine(prisma, actor, message, target)).toEqual({
        ...target,
        threadId: "main",
      });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a chat the message cannot be written in, never falling back to the main chat", async () => {
    const prisma = prismaWith(chats);
    for (const chatId of ["old", "trails", "missing"])
      await expect(
        dozoMentionedRoutine(prisma, actor, { chatBotId: "bot-1", chatId }, target),
      ).rejects.toBeInstanceOf(IsolationError);
  });
});
