import { useLingui } from "@lingui/react/macro";
import type { ComponentProps } from "react";
import { Alert, Platform, Pressable } from "react-native";
import { queueLine, queueSheet, stopText, useDozoQueue } from "../../lib/dozo-queue";
import { showIOSActionSheet } from "../../lib/ios-action-sheet";
import { ThreadWorkingFooter } from "./thread-list-controls";

type FooterProps = ComponentProps<typeof ThreadWorkingFooter>;

/**
 * The chat's working line. While the caller's own work waits for the bot it says so, what it waits
 * for and, when several wait, its place; tapping it opens a native sheet that lists what waits and
 * stops the caller's own. With nothing of the caller's waiting it is the plain working line.
 */
export function DozoWaitingFooter({
  target,
  ...footer
}: FooterProps & { target?: { botId: string } | { groupId: string } }) {
  return target ? <Waiting target={target} {...footer} /> : <ThreadWorkingFooter {...footer} />;
}

function Waiting({
  target,
  label,
  ...footer
}: FooterProps & { target: { botId: string } | { groupId: string } }) {
  const { t } = useLingui();
  const { items, cancel } = useDozoQueue(target);
  const line = queueLine(items);
  if (!line) return <ThreadWorkingFooter {...footer} label={label} />;
  const open = () => {
    const { message, own } = queueSheet(items);
    const stop = (index: number) => {
      const item = own[index];
      if (item && !cancel.pending) cancel.run(item);
    };
    if (Platform.OS === "ios") {
      showIOSActionSheet(
        {
          message,
          options: [...own.map(stopText), t`Cancel`],
          cancelButtonIndex: own.length,
        },
        stop,
      );
      return;
    }
    Alert.alert(line, message, [
      ...own.slice(0, 2).map((item) => ({
        text: stopText(item),
        onPress: () => cancel.run(item),
      })),
      { text: t`Cancel`, style: "cancel" as const },
    ]);
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={line} onPress={open}>
      <ThreadWorkingFooter {...footer} label={line} />
    </Pressable>
  );
}
