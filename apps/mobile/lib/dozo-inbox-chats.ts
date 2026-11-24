import type { DozoBotChat, SpaceBot } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { useMemo } from "react";
import { useDozoSpaceChats } from "./dozo-bot-chats";
import type { InboxItem } from "./inbox-spaces";
import { inboxItemKey, inboxSignal } from "./inbox-spaces";
import type { MobileBot } from "./mobile-types";
import type { InboxSignal } from "./offscreen-unreads";
import { useSnoozeClock } from "./use-snooze-clock";

/** An inbox row: upstream's, or one of a bot's extra chats under the bot's own row. */
export type DozoInboxItem =
  | InboxItem
  | { type: "botChat"; bot: MobileBot | SpaceBot; chat: DozoBotChat };

const NO_CHATS: DozoBotChat[] = [];

/** The row's key; an extra chat's is its own id, which no bot's or group's can be. */
export function dozoInboxItemKey(item: DozoInboxItem): string {
  return item.type === "botChat" ? `chat-${item.chat.id}` : inboxItemKey(item);
}

/** What the row adds to the off-screen unread pills: an extra chat's own unread, never attention. */
export function dozoInboxSignal(item: DozoInboxItem): InboxSignal {
  return item.type === "botChat"
    ? { unread: item.chat.unread ? 1 : 0, attention: 0 }
    : inboxSignal(item);
}

/**
 * The extra chats under their bot's row, as web's roster lists them: open and awake ones only
 * (a snoozed chat leaves until it wakes). A bot with none, and a list not read yet, add nothing:
 * the rows are then the very ones given.
 */
export function dozoInboxItems(
  items: DozoInboxItem[],
  chats: readonly DozoBotChat[] | undefined,
  now: number,
): DozoInboxItem[] {
  const byBot = new Map<string, DozoBotChat[]>();
  for (const chat of chats ?? NO_CHATS) {
    if (chat.archivedAt || chatSnoozed(chat, now)) continue;
    byBot.set(chat.botId, [...(byBot.get(chat.botId) ?? []), chat]);
  }
  if (byBot.size === 0) return items;
  return items.flatMap((item): DozoInboxItem[] =>
    item.type === "bot"
      ? [
          item,
          ...(byBot.get(item.bot.id) ?? []).map((chat) => ({
            type: "botChat" as const,
            bot: item.bot,
            chat,
          })),
        ]
      : [item],
  );
}

/**
 * The inbox's rows with each bot's extra chats under it. One read of the Space's chats, not one
 * per bot, again on each roster signal. Only while `enabled`: the share picker lists bots only.
 */
export function useDozoInboxItems(items: DozoInboxItem[], enabled: boolean): DozoInboxItem[] {
  const chats = useDozoSpaceChats(enabled);
  const now = useSnoozeClock(chats ?? NO_CHATS);
  return useMemo(
    () => dozoInboxItems(items, enabled ? chats : undefined, now),
    [items, enabled, chats, now],
  );
}
