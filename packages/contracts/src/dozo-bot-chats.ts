import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** A bot holds at most this many open extra chats; archived ones do not count. */
export const DOZO_BOT_CHATS_MAX = 20;
export const DOZO_BOT_CHAT_NAME_MAX_LENGTH = 80;

/** What `create` and `archive` answer when the bot already holds the most open extra chats. */
export const DOZO_BOT_CHATS_LIMIT_CODE = "dozo_bot_chats_limit";

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
});
export type DozoBotChat = z.infer<typeof DozoBotChatSchema>;

const ChatOutput = z.object({ chat: DozoBotChatSchema });

export const dozoChatsContract = {
  /** The bot's extra chats, oldest first; archived ones only when asked for. */
  list: oc
    .input(z.object({ botId: Id, includeArchived: z.boolean().optional() }))
    .output(z.object({ chats: z.array(DozoBotChatSchema) })),
  create: oc.input(z.object({ botId: Id, name: DozoBotChatName })).output(ChatOutput),
  rename: oc.input(z.object({ chatId: Id, name: DozoBotChatName })).output(ChatOutput),
  /** Archives or brings back an extra chat; doing what is already done succeeds. */
  archive: oc.input(z.object({ chatId: Id, archived: z.boolean() })).output(ChatOutput),
};
