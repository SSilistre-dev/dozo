import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat, SpaceBot } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import { memo, useContext } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MobileBot } from "../lib/api/mobile-types";
import { androidRipple } from "../lib/appearance/ripple";
import { dozoChatRoute, useDozoChatMenu } from "../lib/dozo-bot-chats";
import { openChatFromInbox } from "../lib/inbox/inbox-changes";
import { native, useThemedStyles } from "../lib/native/native";
import { CompactRowsContext, SelectedChatContext } from "./inbox/inbox-rows";
import { COMPACT_INBOX_ROW, createInboxStyles, INBOX_ROW } from "./inbox/inbox-styles";
import { DragSafePressable } from "./ui/drag-safe-pressable";

/**
 * One of a bot's extra chats under the bot's row, in line with the bot's name: its name and its own
 * unread dot (the bot's row and the badge count the main chat only). A tap opens the chat on its
 * own route; a long press, or the row's action, opens the chat's sheet, which acts on this chat.
 */
export const DozoInboxChatRow = memo(function DozoInboxChatRow({
  bot,
  chat,
}: {
  bot: MobileBot | SpaceBot;
  chat: DozoBotChat;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const home = useThemedStyles(createInboxStyles);
  const compact = useContext(CompactRowsContext);
  const selected = useContext(SelectedChatContext) === chat.id;
  const menu = useDozoChatMenu(chat.botId);
  const rowInset = compact ? COMPACT_INBOX_ROW : INBOX_ROW;
  const more = () => menu.open(chat, false);
  return (
    <>
      <View style={{ paddingLeft: rowInset.padding + INBOX_ROW.avatarSize + rowInset.gap }}>
        <DragSafePressable
          accessibilityRole="button"
          accessibilityLabel={chat.unread ? `${chat.name}${t` (unread)`}` : chat.name}
          accessibilityState={{ selected }}
          accessibilityActions={[{ name: "more", label: t`More` }]}
          onAccessibilityAction={more}
          android_ripple={androidRipple()}
          onPress={() => {
            const href = dozoChatRoute(chat.botId, chat.id, bot.name);
            if (!openChatFromInbox(href)) router.push(href);
          }}
          onLongPress={more}
          style={({ pressed }) => [
            styles.row,
            selected ? styles.selected : null,
            pressed ? home.rowPressed : null,
          ]}
        >
          <Text
            style={[styles.name, chat.unread && styles.unreadName]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {chat.name}
          </Text>
          {chat.unread ? <View accessibilityElementsHidden style={home.unreadDot} /> : null}
        </DragSafePressable>
      </View>
      {menu.dialog}
    </>
  );
});

function createStyles() {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 40,
      paddingRight: INBOX_ROW.padding,
    },
    selected: { borderRadius: 12, backgroundColor: native.fillPressed },
    name: {
      flexShrink: 1,
      color: native.secondaryLabel,
      ...typeScale.body,
      writingDirection: "auto",
    },
    unreadName: { color: native.label, fontWeight: "600" },
  });
}
