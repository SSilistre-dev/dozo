import { StyleSheet, View } from "react-native";
import { dozoChatParam } from "../lib/dozo-chat-target";
import type { ChatTitleParams } from "./chat-header-title";
import { ChatHeaderTitle } from "./chat-header-title";
import { DozoChatSwitcher } from "./dozo-chat-switcher";

/**
 * Upstream's chat title with the chat switcher beside it, in a one-to-one bot chat that can be
 * written to: a group has no extra chats, and an archived bot's chat is read only. The route
 * carries `chatId`, or `threadId` from a notification.
 */
export function DozoChatHeaderTitle({
  routeKey,
  params,
}: {
  routeKey: string;
  params: ChatTitleParams & { chatId?: string; threadId?: string };
}) {
  const { botId, groupId, name, readOnly } = params;
  const title = <ChatHeaderTitle routeKey={routeKey} params={params} />;
  if (!botId || groupId || readOnly === "1") return title;
  return (
    <View style={styles.row}>
      {title}
      <DozoChatSwitcher
        botId={botId}
        chatId={dozoChatParam(params.chatId)}
        threadId={dozoChatParam(params.threadId)}
        name={name}
      />
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center" } });
