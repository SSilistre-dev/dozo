import { useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator } from "react-native";
import { useDozoRouteChat } from "../lib/dozo-chat-route";
import { DozoChatContext } from "../lib/dozo-chat-target";
import { useMobileTokens } from "../lib/native";

/**
 * The chat route's own chat. A route holds one chat (a bot's main chat, or one of its extra chats)
 * for as long as it shows it: the chat is passed down from here, not kept in a module, so two
 * routes of one bot stacked on each other each read their own. The screen under it starts over
 * when the route is pointed at another chat (a notification for another chat of the bot reuses
 * the route), so no state, draft or subscription of one chat is carried into the next.
 */
export function DozoChatScope({ children }: { children: ReactNode }) {
  const tokens = useMobileTokens();
  const { botId, chatId, threadId } = useLocalSearchParams<{
    botId?: string | string[];
    chatId?: string | string[];
    threadId?: string | string[];
  }>();
  const route = useDozoRouteChat({ botId, chatId, threadId });
  if (route.pending) return <ActivityIndicator color={tokens.foreground} />;
  return (
    <DozoChatContext.Provider key={route.chatId ?? "main"} value={route.chatId}>
      {children}
    </DozoChatContext.Provider>
  );
}
