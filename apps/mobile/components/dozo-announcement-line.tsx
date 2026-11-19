import { useLingui } from "@lingui/react/macro";
import { StyleSheet, Text, View } from "react-native";
import { announcementQuery, announcementText } from "../lib/dozo-site-settings";
import { useMobileTokens } from "../lib/native";
import { useScreenQuery } from "../lib/screen-query";

/**
 * The admin's announcement as one line above the chats, in the app's language, only when there is
 * one. Read when the screen gains focus, when the app comes back and on the live stream's signal.
 */
export function DozoAnnouncementLine() {
  const { i18n } = useLingui();
  const tokens = useMobileTokens();
  const text = announcementText(useScreenQuery(announcementQuery()).data, i18n.locale);
  if (!text) return null;
  return (
    <View accessibilityRole="summary" style={[styles.line, { borderColor: tokens.border }]}>
      <Text style={[styles.text, { color: tokens.mutedForeground }]} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 15 },
});
