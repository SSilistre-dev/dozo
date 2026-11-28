import { useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, MessageBlock } from "@rakazo/contracts";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useThemedStyles } from "../../lib/native/native";
import { BotAvatar } from "../bots/bot-avatar";

/**
 * A handoff in a one-to-one chat: the other bot, as a button to its chat, and the handoff note.
 * In the handing bot's chat the arrow leads to the next bot; in the next bot's chat it leads away
 * from the bot that handed it over.
 */
export function DozoHandoffMarker({
  handoff,
  botId,
  bots,
  onOpenBot,
  actionProps,
}: {
  handoff: Extract<MessageBlock, { kind: "handoff" }>;
  /** The bot that wrote the message, which is the chat's own bot. */
  botId: string | undefined;
  bots: readonly { id: string; name: string; color: string; avatarSet?: BotAvatarSet | null }[];
  onOpenBot: (botId: string, name: string) => void;
  actionProps: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const incoming = botId === handoff.toBotId;
  const peerId = incoming ? handoff.fromBotId : handoff.toBotId;
  const peer = bots.find((bot) => bot.id === peerId);
  const arrow = <Text style={styles.label}>↪</Text>;
  return (
    <View style={styles.marker}>
      <Pressable
        {...actionProps}
        testID="handoff-marker"
        accessible
        accessibilityRole={peer ? "button" : undefined}
        accessibilityLabel={peer ? t`Open chat with ${peer.name}` : undefined}
        disabled={!peer}
        onPress={peer ? () => onOpenBot(peer.id, peer.name) : undefined}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
      >
        {incoming ? null : arrow}
        <BotAvatar
          avatarSet={peer?.avatarSet ?? undefined}
          color={peer?.color ?? mobileTokens().mutedForeground}
          identity={peerId}
          size={16}
        />
        {peer ? (
          <Text numberOfLines={1} style={[styles.label, styles.name]}>
            {peer.name}
          </Text>
        ) : null}
        {incoming ? arrow : null}
      </Pressable>
      <Text style={styles.note}>{handoff.text}</Text>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    marker: { width: "100%", paddingVertical: 4, alignItems: "center", gap: 2 },
    line: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
    label: { color: tokens.mutedForeground, fontSize: 13 },
    name: { fontWeight: "500", flexShrink: 1 },
    note: { color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" },
  });
}
