import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { DozoBotChat } from "@rakazo/contracts";
import { chatSnoozed, nextChatWake } from "@rakazo/core";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { mobileTokens } from "../lib/appearance/appearance";
import { dozoChatRoute, useDozoBotChats, useDozoChatMenu } from "../lib/dozo-bot-chats";
import { useDozoPins } from "../lib/dozo-message-actions";
import { formatSnoozeWake } from "../lib/inbox/inbox";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";

/**
 * The bot's extra chats on its profile, only when it has some: a bot without any shows nothing
 * here, as before. A tap opens the chat; a long press (or the row's action) opens its sheet.
 */
export function DozoBotChatsGroup({ botId, botName }: { botId: string; botName: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const chats = useDozoBotChats(botId);
  const menu = useDozoChatMenu(botId);
  const waking = chats ? nextChatWake(chats, Date.now()) : null;
  const now = useNow(waking === null ? null : 60_000);
  if (!chats?.length) return null;
  return (
    <>
      <SettingsGroup label={t`Chats`}>
        {chats.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            snoozed={chatSnoozed(chat, now)}
            onOpen={() => router.push(dozoChatRoute(botId, chat.id, botName))}
            onMenu={(snoozed, pinned) => menu.open(chat, snoozed, pinned)}
          />
        ))}
      </SettingsGroup>
      {menu.dialog}
    </>
  );
}

function ChatRow({
  chat,
  snoozed,
  onOpen,
  onMenu,
}: {
  chat: DozoBotChat;
  snoozed: boolean;
  onOpen: () => void;
  onMenu: (snoozed: boolean, pinned: boolean) => void;
}) {
  const { t } = useLingui();
  // Pinned is in the sheet only while the chat has pinned messages, as in the web header.
  const pinned = Boolean(useDozoPins(chat.id)?.length);
  return (
    <SettingsRow
      accessibilityRole="button"
      accessibilityLabel={chat.unread ? `${chat.name}${t` (unread)`}` : chat.name}
      accessibilityActions={[{ name: "more", label: t`More` }]}
      onAccessibilityAction={() => onMenu(snoozed, pinned)}
      chevron="right"
      dimmed={snoozed}
      title={chat.name}
      value={snoozed && chat.snoozedUntil ? formatSnoozeWake(chat.snoozedUntil) : undefined}
      trailing={chat.unread ? <UnreadDot /> : undefined}
      onPress={onOpen}
      onLongPress={() => onMenu(snoozed, pinned)}
    />
  );
}

function UnreadDot() {
  const tokens = mobileTokens();
  return (
    <View accessibilityElementsHidden style={[styles.dot, { backgroundColor: tokens.unread }]} />
  );
}

const styles = StyleSheet.create({ dot: { width: 8, height: 8, borderRadius: 4 } });
