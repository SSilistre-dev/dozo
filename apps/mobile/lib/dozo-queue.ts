import { t } from "@lingui/core/macro";
import type { DozoQueueItem } from "@rakazo/contracts";
import { Alert } from "react-native";
import { queryClient, rpcQuery, useSave } from "./query";
import { useSpaceChanges } from "./roster-signals";
import { useScreenQuery } from "./screen-query";
import { errorText } from "./user-error";

/** Rows the sheet lists before it folds the rest into a count, as on the web. */
const LIST_ROWS = 4;

type QueueTarget = { botId: string } | { groupId: string };

/** The chat's working line while the caller's own work waits; null when none of it does. */
export function queueLine(items: readonly DozoQueueItem[]): string | null {
  const first = items.find((item) => item.mine);
  if (!first) return null;
  return [t`Waiting in line…`, first.reason === "behind_run" && first.waitingFor ? t`After ${first.waitingFor}` : null, items.length > 1 ? `#${first.position}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** What the sheet lists (one row per line, up to four) and the caller's own work it can stop. */
export function queueSheet(items: readonly DozoQueueItem[]): {
  message: string;
  own: DozoQueueItem[];
} {
  const shown = items.slice(0, LIST_ROWS);
  const rows = shown.map(
    (item) => `${item.position}  ${item.mine && item.label ? item.label : t`Queued`}`,
  );
  if (items.length > shown.length) rows.push(`+${items.length - shown.length}`);
  return { message: rows.join("\n"), own: shown.filter((item) => item.mine) };
}

/** What the sheet's stop buttons are called: the row's name beside the action. */
export function stopText(item: DozoQueueItem): string {
  return item.label ? `${t`Stop`} · ${item.label}` : t`Stop`;
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
