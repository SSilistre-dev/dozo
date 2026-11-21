import { describe, expect, it, vi } from "vitest";
import { retainRunConversation } from "./conversation-memory.js";
import { compactHistory } from "./history-compaction.js";

/**
 * A bot's extra chat is a thread with no owner column; the runtime reads it as its bot's own
 * (`withDozoChatBot`), so a summary and the bot's memory follow it as they follow the main chat.
 * The database fakes answer the extra chat's row as `dozo_bot_chats` would.
 */
function chatRow(botId: string | null) {
  return vi.fn(async () => (botId ? [{ botId }] : []));
}

const extraChat = {
  id: "chat-1",
  spaceId: "space-1",
  userId: "owner",
  botId: null,
  groupId: null,
  externalConversationId: null,
  helperBotId: null,
  nextMessageSeq: 3,
  historyCompactionRetryAfterSeq: 10,
  historyCompactedUpToSeq: null,
  historyCompactionSummary: null,
  historyCompactionGeneration: 0,
};

describe("history compaction in a bot's extra chat", () => {
  function deps(botId: string | null) {
    const spaceMember = vi.fn(async () => ({ id: "member" }));
    return {
      spaceMember,
      deps: {
        prisma: {
          $queryRaw: chatRow(botId),
          thread: { findUniqueOrThrow: vi.fn(async () => extraChat) },
          spaceMember: { findUnique: spaceMember },
        },
        runtime: {},
        jobs: {},
        memoryProviders: { resolve: vi.fn() },
      } as unknown as Parameters<typeof compactHistory>[0],
    };
  }

  it("goes on past the chat's bot, as in the main chat", async () => {
    const { deps: chat, spaceMember } = deps("bot-1");
    await compactHistory(chat, "chat-1", "another-member");
    // Only a chat with a bot gets as far as asking who pays for its summary.
    expect(spaceMember).toHaveBeenCalledTimes(1);
  });

  it("still leaves a thread that is nobody's", async () => {
    const { deps: orphan, spaceMember } = deps(null);
    await compactHistory(orphan, "chat-1", "another-member");
    expect(spaceMember).not.toHaveBeenCalled();
  });
});

describe("memory of a turn in a bot's extra chat", () => {
  function deps(chatBotId: string | null) {
    const resolve = vi.fn(async () => null);
    return {
      resolve,
      deps: {
        prisma: {
          $queryRaw: chatRow(chatBotId),
          run: {
            findUnique: vi.fn(async () => ({
              id: "run-1",
              spaceId: "space-1",
              botId: "bot-1",
              threadId: "chat-1",
              userId: "owner",
              sourceMessageId: "message-1",
            })),
          },
          thread: {
            findUnique: vi.fn(async () => ({
              botId: null,
              groupId: null,
              spaceId: "space-1",
              historyCompactionGeneration: 0,
            })),
          },
        },
        memoryProviders: { resolve },
        jobs: {},
      } as unknown as Parameters<typeof retainRunConversation>[0],
    };
  }

  it("is the bot's, as a turn in its main chat is", async () => {
    const { deps: chat, resolve } = deps("bot-1");
    await retainRunConversation(chat, "run-1");
    expect(resolve).toHaveBeenCalledWith("space-1");
  });

  it("is not kept for another bot's chat", async () => {
    const { deps: other, resolve } = deps("bot-2");
    await retainRunConversation(other, "run-1");
    expect(resolve).not.toHaveBeenCalled();
  });
});
