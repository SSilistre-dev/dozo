import { createContext, useContext } from "react";

/**
 * Which chat a screen is about: a bot's main chat (`botId`), a group's (`groupId`), or one of a
 * bot's extra chats (`botId` with `chatId`, which is that chat's thread).
 */
export type DozoChatRef = { botId?: string; groupId?: string; chatId?: string };

/**
 * What a chat request names, as the contract has it: exactly one chat. An extra chat travels as
 * `chatBotId` with `chatId` and never as `botId`: a server from before extra chats drops fields it
 * does not know, so it would act on the bot's main chat; this shape it refuses instead.
 */
export type DozoChatTarget =
  | { botId: string }
  | { groupId: string }
  | { chatBotId: string; chatId: string };

/**
 * The one place a chat on screen becomes the target of a request. A group has no extra chats, so
 * its id wins; without a bot or a group it is what the screens always sent (a bot with no id).
 */
export function dozoChatTarget({ botId, groupId, chatId }: DozoChatRef): DozoChatTarget {
  if (groupId) return { groupId };
  return botId && chatId ? { chatBotId: botId, chatId } : { botId: botId! };
}

/**
 * Which chat a screen is on, as the refs that tell two chats apart carry it (a pinned page, a
 * saved copy): the group, the bot and its extra chat, or the bot's main chat. Not a request.
 */
export function dozoChatIdentity({ botId, groupId, chatId }: DozoChatRef): DozoChatRef {
  if (groupId) return { groupId };
  return botId && chatId ? { botId, chatId } : { botId };
}

/** The key a chat's saved copy is kept under: an extra chat's own, else the group's or the bot's. */
export function dozoSavedChatTarget({ botId, groupId, chatId }: DozoChatRef): string {
  if (groupId) return `group:${groupId}`;
  return chatId ? `chat:${chatId}` : `bot:${botId}`;
}

/** True when the saved or fetched snapshot is the chat `target` (a `dozoSavedChatTarget`) names. */
export function dozoSnapshotIs(
  snapshot: { botId?: string; groupId?: string; threadId?: string },
  target: string,
): boolean {
  return target.startsWith("chat:")
    ? snapshot.threadId === target.slice("chat:".length)
    : dozoSavedChatTarget(snapshot) === target;
}

/** True when a request body names one of a bot's extra chats. */
export function dozoIsChatBody(body: unknown): boolean {
  return (
    Boolean(body) &&
    typeof body === "object" &&
    typeof (body as { chatId?: unknown }).chatId === "string"
  );
}

/** What the avatar's live feed is kept under: an extra chat's own key never holds a snapshot. */
export function dozoAvatarFeedKey(target: DozoChatTarget): string {
  if ("groupId" in target) return `group:${target.groupId}`;
  return "chatId" in target ? `chat:${target.chatId}` : `bot:${target.botId}`;
}

/**
 * A request body as the consent check reads its target: an extra chat's bot is the one its
 * recipients are asked about, as for its main chat.
 */
export function dozoConsentBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const { chatBotId, botId } = body as { chatBotId?: unknown; botId?: unknown };
  return typeof chatBotId === "string" && botId === undefined
    ? { ...body, botId: chatBotId }
    : body;
}

/**
 * What keeps one chat's state (draft, unsent sends, read visit, attachments) apart from every
 * other: an extra chat's own id, else the group's or the bot's as before.
 */
export function dozoChatKey({ botId, groupId, chatId }: DozoChatRef): string | undefined {
  return groupId ?? chatId ?? botId;
}

/** A bot chat's composer key (`bot:<id>`) with its extra chat's id after it, as the web has it. */
export function dozoDraftKey(key: string, chatId: string | undefined): string {
  return chatId ? `${key}:chat:${chatId}` : key;
}

/** The chat a route names with its `chatId` parameter, or none. */
export function dozoChatParam(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  const trimmed = single?.trim();
  return trimmed || undefined;
}

/**
 * The bot's extra chat the chat route shows, set by the route's `DozoChatScope`: the screen and
 * every row under it read it from here, so two routes of one bot (its main chat and an extra chat)
 * stacked on each other never share it.
 */
export const DozoChatContext = createContext<string | undefined>(undefined);

/** The open chat's extra-chat id; none on a bot's main chat and on a group. */
export function useDozoChatId(): string | undefined {
  return useContext(DozoChatContext);
}

/** The helper stop request names the chat the helper's card is in. */
export function dozoHelperTarget(
  helper: { botId: string; messageId: string },
  chatId: string | undefined,
): { botId: string; messageId: string } | { chatBotId: string; chatId: string; messageId: string } {
  if (!chatId) return helper;
  const { botId, messageId } = helper;
  return { chatBotId: botId, chatId, messageId };
}
