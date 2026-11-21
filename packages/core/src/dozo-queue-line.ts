import type { DozoQueueItem } from "@rakazo/contracts";

/** Rows the list shows before it folds the rest into a count, on every surface. */
export const QUEUE_LIST_ROWS = 4;

/** The words of the line, already in the reader's language: each surface translates its own. */
export interface QueueLineWords {
  waiting: string;
  after: (name: string) => string;
}

/**
 * The chat's working line while the caller's own work waits for a bot: that it waits, what for
 * (only a routine's name the caller knows) and, when more than one piece of work waits for the same
 * bot, its place in that bot's line. Another bot's work is not in its way, so it is not counted.
 * Null when none of the caller's work waits.
 */
export function queueLine(items: readonly DozoQueueItem[], words: QueueLineWords): string | null {
  const first = items.find((item) => item.mine);
  if (!first) return null;
  const sharesLine = items.some((item) => item !== first && item.botId === first.botId);
  return [
    words.waiting,
    first.reason === "behind_run" && first.waitingFor ? words.after(first.waitingFor) : null,
    sharesLine ? `#${first.position}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What the list shows: the first rows with the name of each (the caller's own work by its label,
 * anyone else's only as `queued`) and how many are folded into a count.
 */
export function queueRows(items: readonly DozoQueueItem[], queued: string) {
  const shown = items.slice(0, QUEUE_LIST_ROWS).map((item) => ({
    item,
    text: item.mine && item.label ? item.label : queued,
  }));
  return { shown, hidden: items.length - shown.length };
}
