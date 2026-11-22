import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { dozoChatParam, dozoSavedChatTarget } from "./dozo-chat-target";
import { queryClient, rpcQuery } from "./query";
import { readSavedThread, savedChatsScope } from "./saved-chats";
import { useInboxBot } from "./search-inbox";

/** What the route shows: a chat (an extra chat's id, none for the main chat), or the bot's profile. */
export type DozoRouteChat =
  | { chatId: string | undefined; pending: false; profile: false }
  | { chatId: undefined; pending: true; profile: false }
  | { chatId: undefined; pending: false; profile: true };

/**
 * The thread of a bot's main chat as the phone saved it: undefined while the saved copy is being
 * read, null when there is none. Read only when `enabled`, so a route that needs it not asks.
 */
function useSavedMainThread(botId: string | undefined, enabled: boolean) {
  const [saved, setSaved] = useState<{ botId: string; threadId: string | null }>();
  useEffect(() => {
    if (!enabled || !botId) return;
    let live = true;
    void savedChatsScope().then((scope) => {
      if (!live) return;
      const copy = scope ? readSavedThread(scope, dozoSavedChatTarget({ botId })) : null;
      setSaved({ botId, threadId: copy?.threadId ?? null });
    });
    return () => {
      live = false;
    };
  }, [botId, enabled]);
  return saved && saved.botId === botId ? saved.threadId : undefined;
}

/**
 * Which chat of a bot a `/thread` route shows. The app names an extra chat with `chatId`. A
 * notification names only its thread (`threadId`), which is the bot's main chat or one of its
 * extra chats.
 *
 * The main chat opens at once, with no request, when the phone knows its thread (the bot as the
 * inbox last loaded it, or its saved copy) and the notification is about that one: a bot with no
 * extra chats opens as it always did, offline too. Any other thread waits for the bot's chat list
 * (`pending`, so no chat is read, marked or suppressed by mistake) and opens when the list names
 * it as an open chat of the bot. A thread the list does not name is the main chat when nothing
 * says which thread that is (as the web opens an address naming no open chat); when the main
 * thread is known and is another one, it is an archived or gone chat, and the list cannot be
 * read at all: the main chat is then the wrong chat, so the route shows the bot's profile, where
 * its chats are listed and read again.
 */
export function useDozoRouteChat(params: {
  botId?: string | string[];
  chatId?: string | string[];
  threadId?: string | string[];
}): DozoRouteChat {
  const botId = dozoChatParam(params.botId);
  const named = dozoChatParam(params.chatId);
  const threadId = dozoChatParam(params.threadId);
  const inbox = useInboxBot(botId);
  const inboxMain = inbox && "threadId" in inbox ? inbox.threadId : undefined;
  const notification = !named && Boolean(botId && threadId);
  const saved = useSavedMainThread(botId, notification && !inboxMain);
  const knownMain = inboxMain ?? saved ?? undefined;
  const savedRead = Boolean(inboxMain) || saved !== undefined;
  const lookup = notification && savedRead && knownMain !== threadId;
  const list = useQuery(
    { ...rpcQuery("dozoChats/list", { botId: botId ?? "" }), enabled: lookup },
    queryClient,
  );
  if (named) return { chatId: named, pending: false, profile: false };
  if (!notification) return { chatId: undefined, pending: false, profile: false };
  if (!savedRead) return { chatId: undefined, pending: true, profile: false };
  if (!lookup) return { chatId: undefined, pending: false, profile: false };
  if (list.isPending) return { chatId: undefined, pending: true, profile: false };
  if (list.isError) return { chatId: undefined, pending: false, profile: true };
  const found = list.data.chats.find(
    (chat) => chat.id === threadId && chat.botId === botId && !chat.archivedAt,
  );
  if (found) return { chatId: found.id, pending: false, profile: false };
  return knownMain
    ? { chatId: undefined, pending: false, profile: true }
    : { chatId: undefined, pending: false, profile: false };
}
