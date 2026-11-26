import { t } from "@lingui/core/macro";
import type { DozoQueueItem } from "@rakazo/contracts";
import { queueLine as queueLineOf, queueRows } from "@rakazo/core";
import { Alert } from "react-native";
import { queryClient, rpcQuery, useSave } from "./query/query";
import { useSpaceChanges } from "./api/roster-signals";
import { useScreenQuery } from "./query/screen-query";
import { errorText } from "./api/user-error";

type QueueTarget = { botId: string } | { groupId: string };

/** The chat's working line while the caller's own work waits; null when none of it does. */
export function queueLine(items: readonly DozoQueueItem[]): string | null {
  return queueLineOf(items, {
    waiting: t`Waiting in line…`,
    after: (name) => t`After ${name}`,
  });
}

/** What the sheet lists (one row per line, up to four) and the caller's own work it can stop. */
export function queueSheet(items: readonly DozoQueueItem[]): {
  message: string;
  own: DozoQueueItem[];
} {
  const { shown, hidden } = queueRows(items, t`Queued`);
  const rows = shown.map(({ item, text }) => `${item.position}  ${text}`);
  if (hidden > 0) rows.push(`+${hidden}`);
  return {
    message: rows.join("\n"),
    own: shown.map((row) => row.item).filter((item) => item.mine),
  };
}

/** What the sheet's stop buttons are called: the row's name beside the action. */
export function stopText(item: DozoQueueItem): string {
  return item.label ? `${t`Stop`}: ${item.label}` : t`Stop`;
}

/**
 * What waits for the bot (or the group), read once and read again on the Space's runs signal,
 * never on a timer, and the caller's stop for its own queued run or held message.
 */
export function useDozoQueue(target: QueueTarget) {
  const read = rpcQuery("dozoQueue/list", target);
  const items = useScreenQuery(read).data?.items ?? [];
  useSpaceChanges("runs", () => queryClient.invalidateQueries({ queryKey: read.queryKey }), true);
  const cancel = useSave({
    save: (item: DozoQueueItem, send) =>
      send(
        "dozoQueue/cancelWaiting",
        item.kind === "run" ? { runId: item.id } : { messageId: item.id },
      ),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error)),
  });
  return { items, cancel };
}
