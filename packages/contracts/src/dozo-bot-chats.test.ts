import { describe, expect, it } from "vitest";
import * as z from "zod";
import { dozoThreadTargetCheck } from "./dozo-bot-chats.js";
import { DozoChatExportInputSchema } from "./dozo-chat-export.js";

/** A chat target as the app contract has it, and as an API from before extra chats had it. */
const target = z
  .object({
    botId: z.string().optional(),
    groupId: z.string().optional(),
    chatBotId: z.string().optional(),
    chatId: z.string().optional(),
  })
  .superRefine(dozoThreadTargetCheck);
const before = z
  .object({ botId: z.string().optional(), groupId: z.string().optional() })
  .superRefine((input, ctx) => {
    if (Boolean(input.botId) === Boolean(input.groupId))
      ctx.addIssue({ code: "custom", message: "Provide exactly one of botId or groupId" });
  });

describe("a chat target", () => {
  it("names one chat: a bot's main chat, a group's, or a bot's extra chat", () => {
    for (const ok of [{ botId: "b" }, { groupId: "g" }, { chatBotId: "b", chatId: "c" }]) {
      expect(target.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      {},
      { botId: "b", chatId: "c" },
      { chatBotId: "b" },
      { chatId: "c" },
      { botId: "b", chatBotId: "b", chatId: "c" },
      { groupId: "g", chatBotId: "b", chatId: "c" },
      { botId: "b", groupId: "g" },
    ]) {
      expect(target.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is refused by an API from before extra chats, which never sees it as the main chat", () => {
    // That API drops chatBotId and chatId as unknown, and then names neither a bot nor a group.
    expect(before.safeParse({ chatBotId: "b", chatId: "c" }).success).toBe(false);
    // The shape it would have taken for the main chat is not one the app sends.
    expect(target.safeParse({ botId: "b", chatId: "c" }).success).toBe(false);
  });

  it("holds the chat export to the same rule", () => {
    expect(DozoChatExportInputSchema.safeParse({ chatBotId: "b", chatId: "c" }).success).toBe(true);
    expect(DozoChatExportInputSchema.safeParse({ botId: "b", chatId: "c" }).success).toBe(false);
  });
});
