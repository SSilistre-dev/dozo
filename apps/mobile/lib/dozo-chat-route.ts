import { useQuery } from "@tanstack/react-query";
import { dozoChatParam } from "./dozo-chat-target";
import { queryClient, rpcQuery } from "./query";
import { useInboxBot } from "./search-inbox";

/**
 * Which chat of a bot a `/thread` route shows. The app names an extra chat with `chatId`. A
 * notification names only its thread (`threadId`), which is the bot's main chat or one of its
 * extra chats: the bot as the inbox last loaded it says when it is the main chat, and the bot's
 * chat list says when it is an extra one. A thread that is neither (an archived chat, one the list
 * cannot show) opens the bot's main chat, as the web opens an address naming no open chat.
 * `pending` while that one read is out, so the screen never opens a chat that is not the one meant.
 */
export function useDozoRouteChat(params: {
  botId?: string | string[];
  chatId?: string | string[];
  threadId?: string | string[];
}): { chatId: string | undefined; pending: boolean } {
  const botId = dozoChatParam(params.botId);
  const named = dozoChatParam(params.chatId);
  const threadId = dozoChatParam(params.threadId);
  const inboxMain = useInboxBot(botId)?.threadId;
  const lookup = !named && Boolean(botId && threadId) && inboxMain !== threadId;
  const list = useQuery(
    { ...rpcQuery("dozoChats/list", { botId: botId ?? "" }), enabled: lookup },
    queryClient,
  );
  if (named) return { chatId: named, pending: false };
  if (!lookup) return { chatId: undefined, pending: false };
  if (list.isPending) return { chatId: undefined, pending: true };
  const found = list.data?.chats.find(
    (chat) => chat.id === threadId && chat.botId === botId && !chat.archivedAt,
  );
  return { chatId: found?.id, pending: false };
}
