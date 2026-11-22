import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { pinLabel, useDozoPins } from "../lib/dozo-message-actions";
import { native, useThemedStyles } from "../lib/native";
import { useScreenHeader } from "../lib/screen-header";
import { useSideInsets } from "../lib/side-insets";

/**
 * The messages the person pinned in one chat, newest first. Choosing one goes back to the chat,
 * opened at that message as a search result opens it.
 */
export default function DozoPins() {
  const {
    threadId,
    botId,
    groupId,
    chatId,
    name = "",
  } = useLocalSearchParams<{
    threadId?: string;
    botId?: string;
    groupId?: string;
    chatId?: string;
    name?: string;
  }>();
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const pins = useDozoPins(threadId);
  useScreenHeader({ title: t`Pinned` });
  const open = (messageId: string) =>
    router.dismissTo(
      groupId
        ? { pathname: "/group-thread", params: { groupId, name, messageId } }
        : {
            pathname: "/thread",
            // A pin in an extra chat opens that chat, never the bot's main chat.
            params: { botId: botId ?? "", ...(chatId ? { chatId } : {}), name, messageId },
          },
    );
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          {pins?.map((pin) => (
            <SettingsRow
              key={pin.messageId}
              accessibilityRole="button"
              chevron="right"
              title={pinLabel(pin, t`Page`, t`Message`)}
              onPress={() => open(pin.messageId)}
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, paddingBottom: 40 },
  });
}
