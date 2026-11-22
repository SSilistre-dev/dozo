import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** A bot holds at most this many open extra chats; archived ones do not count. */
export const DOZO_BOT_CHATS_MAX = 20;
/** And at most this many in all, archived ones included, so archiving cannot grow it forever. */
export const DOZO_BOT_CHATS_TOTAL_MAX = 100;
export const DOZO_BOT_CHAT_NAME_MAX_LENGTH = 80;

/** What `create` and `archive` answer when the bot already holds the most open extra chats. */
export const DOZO_BOT_CHATS_LIMIT_CODE = "dozo_bot_chats_limit";
/** What `create` answers when the bot already holds the most chats, archived ones included. */
export const DOZO_BOT_CHATS_TOTAL_LIMIT_CODE = "dozo_bot_chats_total_limit";

/** A chat's name: one line a person reads in a list, never empty. */
export const DozoBotChatName = z
  .string()
  .trim()
  .min(1)
  .max(DOZO_BOT_CHAT_NAME_MAX_LENGTH)
  .regex(/^[^\p{Cc}]*$/u);

/**
 * One of a bot's extra chats. The bot's main chat is not one of them: it stays the chat clients
 * open by the bot, as before. `id` is the chat's thread.
 */
export const DozoBotChatSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  createdAt: IsoDate,
  archivedAt: IsoDate.nullable(),
  /** The caller's own state of the chat, as for the bot's main chat. */
  unread: z.boolean(),
  snoozedUntil: IsoDate.nullable(),
});
export type DozoBotChat = z.infer<typeof DozoBotChatSchema>;

const ChatOutput = z.object({ chat: DozoBotChatSchema });

/**
 * A chat request names exactly one chat: a bot's main chat (`botId`), a group's (`groupId`), or a
 * bot's extra chat (`chatBotId` with `chatId`). An extra chat never travels as `botId`: an API from
 * before extra chats drops fields it does not know, and would act on the bot's main chat, so a
 * request it cannot understand must fail its own "one of botId or groupId" check instead.
 */
export function dozoThreadTargetCheck(
  input: { botId?: string; groupId?: string; chatBotId?: string; chatId?: string },
  ctx: z.RefinementCtx,
): void {
  const named = [input.botId, input.groupId, input.chatBotId].filter(Boolean).length;
  if (named !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "Provide exactly one of botId, groupId or chatBotId",
      path: ["botId"],
    });
  }
  if (Boolean(input.chatBotId) !== Boolean(input.chatId)) {
    ctx.addIssue({
      code: "custom",
      message: "A bot's extra chat is named with chatBotId and chatId together",
      path: ["chatId"],
    });
  }
}

export const DozoBotChatsListInputSchema = z.object({
  /** One bot's chats; without it, every chat of the Space's bots that are not archived. */
  botId: Id.optional(),
  includeArchived: z.boolean().optional(),
});
export type DozoBotChatsListInput = z.infer<typeof DozoBotChatsListInputSchema>;
export const DozoBotChatCreateInputSchema = z.object({ botId: Id, name: DozoBotChatName });
export type DozoBotChatCreateInput = z.infer<typeof DozoBotChatCreateInputSchema>;
export const DozoBotChatRenameInputSchema = z.object({ chatId: Id, name: DozoBotChatName });
export type DozoBotChatRenameInput = z.infer<typeof DozoBotChatRenameInputSchema>;
export const DozoBotChatArchiveInputSchema = z.object({ chatId: Id, archived: z.boolean() });
export type DozoBotChatArchiveInput = z.infer<typeof DozoBotChatArchiveInputSchema>;

export const DozoRoutineChatInputSchema = z.object({ routineId: Id });
export const DozoRoutineChatSetInputSchema = z.object({
  routineId: Id,
  /** One of the routine's bot's open extra chats, or null for the bot's main chat. */
  chatId: Id.nullable(),
});
export type DozoRoutineChatSetInput = z.infer<typeof DozoRoutineChatSetInputSchema>;
/** Where a bot's routine posts. */
export const DozoRoutineChatSchema = z.object({
  /** The open extra chat its runs post in; null for the bot's main chat. */
  chatId: Id.nullable(),
  /** False for a routine that posts in a group: a bot's chats are not where it posts. */
  editable: z.boolean(),
});
export type DozoRoutineChat = z.infer<typeof DozoRoutineChatSchema>;

export const dozoChatsContract = {
  /** Extra chats, oldest first; archived ones only when asked for. */
  list: oc
    .input(DozoBotChatsListInputSchema)
    .output(z.object({ chats: z.array(DozoBotChatSchema) })),
  create: oc.input(DozoBotChatCreateInputSchema).output(ChatOutput),
  rename: oc.input(DozoBotChatRenameInputSchema).output(ChatOutput),
  /** Archives or brings back an extra chat; doing what is already done succeeds. */
  archive: oc.input(DozoBotChatArchiveInputSchema).output(ChatOutput),
  /** Where a routine posts. A chat since archived reads as the main chat, where it then runs. */
  routineChat: oc.input(DozoRoutineChatInputSchema).output(DozoRoutineChatSchema),
  /** Points a routine at one of its bot's open extra chats, or back at the main chat. */
  setRoutineChat: oc.input(DozoRoutineChatSetInputSchema).output(DozoRoutineChatSchema),
};
