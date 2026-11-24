import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { dozoChatRoute, useDozoBotChats, useDozoNewChat } from "../lib/dozo-bot-chats";
import { native, useResolvedAppearance } from "../lib/native";
import { useInboxBot } from "../lib/search-inbox";
import { NativeSymbol } from "./native-symbol";

const MAIN = "main";
const NEW_CHAT = "new";
const CHAT_PREFIX = "chat:";

/**
 * The menu's rows: the bot's main chat, each open extra chat (the open one marked), then New chat
 * on its own, as web's header menu lists them. `open` is the extra chat on screen, none for the
 * main chat.
 */
export function dozoChatSwitcherActions(
  botName: string,
  chats: readonly DozoBotChat[],
  open: string | undefined,
  newChat: { label: string; disabled: boolean },
): MenuAction[] {
  return [
    { id: MAIN, title: botName, state: open ? "off" : "on" },
    ...chats.map((chat) => ({
      id: `${CHAT_PREFIX}${chat.id}`,
      title: chat.name,
      state: chat.id === open ? ("on" as const) : ("off" as const),
    })),
    {
      id: "new-chat-section",
      title: "",
      displayInline: true,
      subactions: [
        {
          id: NEW_CHAT,
          title: newChat.label,
          image: "plus",
          attributes: { disabled: newChat.disabled },
        },
      ],
    },
  ];
}

/**
 * Beside a bot chat's title: the bot's main chat and extra chats to switch between, and New chat.
 * A switch replaces the chat on screen, so going back and forth never stacks routes. The chat on
 * screen is the route's `chatId`, or the thread a notification named, when that is an extra chat.
 */
export function DozoChatSwitcher({
  botId,
  chatId,
  threadId,
  name,
}: {
  botId: string;
  chatId?: string;
  threadId?: string;
  /** The bot's name as the route carries it, for a bot the inbox has not loaded. */
  name?: string;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const chats = useDozoBotChats(botId);
  const botName = useInboxBot(botId)?.name ?? name ?? "";
  const newChat = useDozoNewChat(botId, botName);
  const open = chats?.find((chat) => chat.id === (chatId ?? threadId))?.id;
  return (
    <MenuView
      actions={dozoChatSwitcherActions(botName || t`Chats`, chats ?? [], open, {
        label: t`New chat`,
        disabled: newChat.pending,
      })}
      colorScheme={colorScheme}
      title={t`Chats`}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === NEW_CHAT) newChat.run(undefined);
        else if (id === MAIN) {
          if (open) router.replace({ pathname: "/thread", params: { botId, name: botName } });
        } else if (id.startsWith(CHAT_PREFIX)) {
          const picked = id.slice(CHAT_PREFIX.length);
          if (picked !== open) router.replace(dozoChatRoute(botId, picked, botName));
        }
      }}
    >
      {/* A sized trigger: an unsized one can collapse to zero width on some Android builds. */}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t`Chats`}
        style={styles.trigger}
      >
        <NativeSymbol
          ios="chevron.down"
          android="chevron-down"
          size={13}
          weight="semibold"
          color={native.secondaryLabel}
        />
      </View>
    </MenuView>
  );
}

const styles = StyleSheet.create({
  trigger: { width: 32, height: 44, alignItems: "center", justifyContent: "center" },
});
