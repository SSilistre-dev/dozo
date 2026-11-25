import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat } from "@rakazo/contracts";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useTextEditDialog } from "../components/bots/profile-edit-dialog";
import { resolveMobileAppearance } from "./appearance/appearance";
import { useChatExport } from "./dozo-chat-export";
import { SNOOZE_LABELS } from "./inbox/inbox-swipe";
import { presentMessageActionSheet } from "./messages/message-action-sheet";
import { queryClient, rpcQuery, useSave } from "./query/query";
import { useRosterSignals } from "./api/roster-signals";
import { errorText } from "./user-error";

/** A chat's name is one line of at most this many characters (the contract's own limit). */
const CHAT_NAME_MAX_LENGTH = 80;

/** The bot's open extra chats, oldest first, with the caller's own read and snooze state. */
const botChatsRead = (botId: string) => rpcQuery("dozoChats/list", { botId });

/**
 * Every open extra chat of the selected Space's bots, in one read: the inbox lists them under their
 * bots without asking once per bot.
 */
const spaceChatsRead = () => rpcQuery("dozoChats/list", {});

/**
 * The selected Space's open extra chats, oldest first, read once and again on each roster signal,
 * never on a timer. Undefined until the first answer, and when the server has no such read.
 */
export function useDozoSpaceChats(enabled: boolean): DozoBotChat[] | undefined {
  const read = spaceChatsRead();
  const chats = useQuery({ ...read, enabled, staleTime: Infinity }, queryClient);
  useRosterSignals(() => queryClient.invalidateQueries({ queryKey: read.queryKey }), enabled);
  return chats.data?.chats;
}

/**
 * The bot's open extra chats, read once and again on each roster signal (a change to a chat or its
 * read state comes on it), never on a timer. Undefined until the first answer.
 */
export function useDozoBotChats(botId: string): DozoBotChat[] | undefined {
  const read = botChatsRead(botId);
  const chats = useQuery({ ...read, enabled: Boolean(botId), staleTime: Infinity }, queryClient);
  useRosterSignals(
    () => queryClient.invalidateQueries({ queryKey: read.queryKey }),
    Boolean(botId),
  );
  return chats.data?.chats;
}

/**
 * The open extra chat's name, so the chat's title says which chat of the bot it is. Reads the
 * bot's list only for an extra chat: a main chat asks nothing here.
 */
export function useDozoChatName(botId: string | undefined, chatId: string | undefined) {
  const chats = useDozoBotChats(chatId ? (botId ?? "") : "");
  return chatId ? chats?.find((chat) => chat.id === chatId)?.name : undefined;
}

/**
 * What the chat's title names: an extra chat by its own name, beside the bot's avatar, which says
 * whose it is; the main chat by the bot's. Until the bot is known, nothing (the title's
 * placeholder).
 */
export function dozoTitleName(botName: string | undefined, chatName: string | undefined) {
  return botName && chatName ? chatName : botName;
}

/** Where a bot's chat opens: its own route, never the route of the bot's main chat. */
export function dozoChatRoute(botId: string, chatId: string, name: string) {
  return { pathname: "/thread" as const, params: { botId, chatId, name } };
}

/**
 * A new chat is named by when it began, so it reads apart from the bot's other chats until it is
 * renamed.
 */
export function newChatName(
  i18n: { date: (value: Date, format: Intl.DateTimeFormatOptions) => string },
  now = new Date(),
): string {
  return i18n.date(now, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Makes a new chat of the bot and opens it. */
export function useDozoNewChat(botId: string, botName: string) {
  const { t, i18n } = useLingui();
  const router = useRouter();
  return useSave({
    save: (_: undefined, send) => send("dozoChats/create", { botId, name: newChatName(i18n) }),
    stale: [botChatsRead(botId).queryKey, spaceChatsRead().queryKey],
    onSaved: ({ chat }) => router.push(dozoChatRoute(botId, chat.id, botName)),
    onFailed: (error) => Alert.alert(t`Could not update chat`, errorText(error, t`Try again.`)),
  });
}

type ChatChange =
  | { kind: "read" | "unread" | "archive" }
  | { kind: "snooze"; until: string | null }
  | { kind: "rename"; name: string };

/**
 * What a chat's long-press sheet does, each as the web menu does it and to that chat only: it
 * names the chat as `chatBotId` with `chatId`, so the bot's main chat is never the one changed.
 */
export function useDozoChatMenu(botId: string) {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const exportChat = useChatExport();
  const rename = useTextEditDialog(t`Rename`, CHAT_NAME_MAX_LENGTH);
  const change = useSave<{ chat: DozoBotChat; change: ChatChange }>({
    save: ({ chat, change }, send) => {
      const target = { chatBotId: chat.botId, chatId: chat.id };
      if (change.kind === "read") return send("threads/markRead", target);
      if (change.kind === "unread") return send("threads/markUnread", target);
      if (change.kind === "snooze")
        return send("threads/snooze", { ...target, until: change.until });
      if (change.kind === "rename")
        return send("dozoChats/rename", { chatId: chat.id, name: change.name });
      return send("dozoChats/archive", { chatId: chat.id, archived: true });
    },
    // The inbox lists the chats of every bot in one read, the profile one bot's.
    stale: [botChatsRead(botId).queryKey, spaceChatsRead().queryKey],
    onFailed: (error) => Alert.alert(t`Could not update chat`, errorText(error, t`Try again.`)),
  });
  const sheet = (title: string, actions: { text: string; onPress: () => void }[]) =>
    presentMessageActionSheet({
      title,
      actions,
      cancel: t`Cancel`,
      more: t`More`,
      colorScheme: resolveMobileAppearance(),
    });
  const snooze = (chat: DozoBotChat) =>
    sheet(
      chat.name,
      SNOOZE_PRESETS.map((preset) => ({
        text: i18n._(SNOOZE_LABELS[preset]),
        onPress: () =>
          change.run({
            chat,
            change: { kind: "snooze", until: snoozePresetTime(preset, new Date()).toISOString() },
          }),
      })),
    );
  return {
    dialog: rename.dialog,
    open(chat: DozoBotChat, snoozed: boolean, pinned = false) {
      sheet(chat.name, [
        {
          text: t`Rename`,
          onPress: () =>
            rename.ask(chat.name, (name) => {
              if (name && name !== chat.name)
                change.run({ chat, change: { kind: "rename", name } });
            }),
        },
        {
          text: chat.unread ? t`Mark as Read` : t`Mark as Unread`,
          onPress: () => change.run({ chat, change: { kind: chat.unread ? "read" : "unread" } }),
        },
        snoozed
          ? {
              text: t`Unsnooze`,
              onPress: () => change.run({ chat, change: { kind: "snooze", until: null } }),
            }
          : { text: t`Snooze`, onPress: () => snooze(chat) },
        ...(pinned
          ? [
              {
                text: t`Pinned`,
                onPress: () =>
                  router.push({
                    pathname: "/dozo-pins" as const,
                    params: {
                      threadId: chat.id,
                      botId: chat.botId,
                      chatId: chat.id,
                      name: chat.name,
                    },
                  }),
              },
            ]
          : []),
        {
          text: t`Export`,
          onPress: () => exportChat({ chatBotId: chat.botId, chatId: chat.id }, chat.name),
        },
        { text: t`Archive`, onPress: () => change.run({ chat, change: { kind: "archive" } }) },
      ]);
    },
  };
}
