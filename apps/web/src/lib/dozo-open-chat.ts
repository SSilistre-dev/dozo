/**
 * The bot's extra chat the shell shows, if any: set while the shell's wrapper renders
 * (`useDozoOpenChat` in `pages/shell/dozo-bot-chats.tsx`), read by what keys or targets the chat
 * on screen. The shell is remounted when it changes, so a value read while it is mounted stays.
 */
type OpenChat = { botId: string; chatId: string };

let openChat: OpenChat | null = null;

export function setDozoOpenChat(chat: OpenChat | null): void {
  openChat = chat;
}

/** `{ chatId }` when this bot's extra chat is the open one, for a request about the open chat. */
export function dozoChatOf(botId: string | undefined): { chatId?: string } {
  return openChat && botId && openChat.botId === botId ? { chatId: openChat.chatId } : {};
}

/** True when an extra chat is open, of this bot when one is named. */
export function dozoExtraChatOpen(botId?: string): boolean {
  return Boolean(openChat && (botId === undefined || openChat.botId === botId));
}

/**
 * A bot chat's composer key (`bot:<id>`), with the open extra chat's id after it, so a draft or a
 * send waiting to be retried belongs to one chat and never shows up, or goes out, in another.
 */
export function dozoDraftKey(key: string, botId: string | undefined): string {
  const chatId = dozoChatOf(botId).chatId;
  return chatId ? `${key}:chat:${chatId}` : key;
}

/** The open extra chat, or null on a main chat or a group. */
export function dozoOpenChat(): OpenChat | null {
  return openChat;
}
