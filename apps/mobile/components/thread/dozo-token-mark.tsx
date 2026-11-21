import { useLingui } from "@lingui/react/macro";
import { View } from "react-native";
import { useMobileTokens } from "../../lib/native";
import { NativeSymbol } from "../native-symbol";

/**
 * Above a message that came in with a personal access token (the bot API, MCP) instead of being
 * typed in an app: a small key, named for screen readers. Its run asks before acting.
 */
export function DozoTokenMark() {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t`Sent with an access token`}
      style={{ alignSelf: "flex-end" }}
    >
      <NativeSymbol ios="key" android="key-outline" size={13} color={tokens.mutedForeground} />
    </View>
  );
}
