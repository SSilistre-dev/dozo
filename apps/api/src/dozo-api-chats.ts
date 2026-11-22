import { ClientError } from "@rakazo/core";
import * as z from "zod";
import type { DozoBotApiClient } from "./dozo-bot-api.js";

/**
 * Which of a bot's chats a token's call reaches, for the bot API and the MCP endpoint alike: the
 * bot's main chat when the call names no chat, as before extra chats, or one of the bot's open
 * extra chats. The one rule both use, so neither checks a chat id on its own.
 */

/**
 * A chat as a token's client sees it. The bot's main chat is not listed: it is the one a call
 * reaches when it names no chat.
 */
export type DozoApiChat = { id: string; name: string; createdAt: string };

/** What the app's procedures take for the chat: the bot alone for its main chat. */
export type DozoApiChatTarget = { botId: string } | { chatBotId: string; chatId: string };

const ChatId = z.string().min(1).max(200);

/**
 * A chat id the token cannot use: not the bot's, not in its Space, archived, or no chat at all.
 * One answer for every case, so a token learns nothing about chats it cannot reach.
 */
export class DozoApiChatNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "Chat not found", "dozo_chat_not_found");
  }
}

/** The bot's open extra chats, oldest first, read as the token's member. */
export async function dozoApiChats(
  client: Pick<DozoBotApiClient, "dozoChats">,
  botId: string,
): Promise<DozoApiChat[]> {
  const { chats } = await client.dozoChats.list({ botId });
  return chats
    .filter((chat) => chat.botId === botId && chat.archivedAt === null)
    .map((chat) => ({ id: chat.id, name: chat.name, createdAt: chat.createdAt }));
}

/**
 * The target for `chatId` of the bot. No chat (`undefined`) is the main chat, exactly as before;
 * anything else must be one of the bot's open extra chats, and is never taken as the main chat.
 */
export async function dozoApiChatTarget(
  client: Pick<DozoBotApiClient, "dozoChats">,
  botId: string,
  chatId: string | undefined,
): Promise<DozoApiChatTarget> {
  if (chatId === undefined) return { botId };
  const id = ChatId.safeParse(chatId);
  if (!id.success) throw new DozoApiChatNotFoundError();
  const chats = await dozoApiChats(client, botId);
  if (!chats.some((chat) => chat.id === id.data)) throw new DozoApiChatNotFoundError();
  return { chatBotId: botId, chatId: id.data };
}
