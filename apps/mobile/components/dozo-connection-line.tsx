import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState, useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { isServerReachable, subscribeServerReachable } from "../lib/api";
import { useMobileTokens } from "../lib/native";

/** A short outage passes unnoticed: the live stream reconnects by itself. */
export const CONNECTION_LINE_DELAY_MS = 20_000;

/**
 * One line above the chats once the server has not answered for a while, gone as soon as any
 * request or the live stream's reconnect reaches it again. Hidden while the chats' own load
 * failure already says so.
 */
export function DozoConnectionLine({ hidden }: { hidden: boolean }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const reachable = useSyncExternalStore(subscribeServerReachable, isServerReachable);
  const [late, setLate] = useState(false);
  if (reachable && late) setLate(false);
  useTimeout(() => setLate(true), reachable ? null : CONNECTION_LINE_DELAY_MS);
  if (hidden || reachable || !late) return null;
  return (
    <View accessibilityRole="summary" style={[styles.line, { borderColor: tokens.border }]}>
      <Text style={[styles.text, { color: tokens.mutedForeground }]} numberOfLines={1}>
        {t`Can't reach the server. Reconnecting…`}
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
