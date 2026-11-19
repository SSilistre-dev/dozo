import { createHash } from "node:crypto";

/** On average, a long history's window start moves once every this many exchanges. */
export const HISTORY_START_STEP = 4;

type Message = { role: string; content?: unknown };
type Group = { indexes: number[]; tokens: number };

/** Whether a window may start at this message: a user message picked by its content alone. */
export function startsHistoryWindow(message: Message) {
  if (message.role !== "user") return false;
  const digest = createHash("sha256")
    .update(JSON.stringify(message.content ?? ""))
    .digest();
  return digest[0]! % HISTORY_START_STEP === 0;
}

/**
 * When a long history is cut, the oldest kept exchange moved by one every turn, so the history
 * after the system prompt never matched the cached prefix and was written again each turn. This
 * drops the oldest kept groups up to the first one whose message may start a window; that message
 * is chosen by its content, so the start stays put for several turns, wherever the stored history
 * the server sent begins. It never drops the last `keepExchanges` exchanges, protected groups or
 * the current request, and does nothing when no history was cut. Returns the tokens dropped.
 */
export function alignHistoryStart(
  messages: readonly Message[],
  groups: readonly Group[],
  selected: Set<Group>,
  protectedIndexes: ReadonlySet<number>,
  currentStart: number,
  keepExchanges: number,
) {
  if (groups.every((group) => selected.has(group))) return 0;
  let exchanges = 0;
  let recentFrom = groups.length;
  for (let index = groups.length - 1; index >= 0; index--) {
    if (groups[index]!.indexes.some((i) => messages[i]!.role === "user")) exchanges += 1;
    if (exchanges > keepExchanges) break;
    recentFrom = index;
  }
  const kept = (group: Group) =>
    selected.has(group) && !group.indexes.some((i) => protectedIndexes.has(i));
  const first = groups.findIndex(kept);
  const start = groups.findIndex(
    (group, index) =>
      index >= first &&
      index < recentFrom &&
      group.indexes[0]! < currentStart &&
      kept(group) &&
      startsHistoryWindow(messages[group.indexes[0]!]!),
  );
  if (first < 0 || start < 0) return 0;
  let dropped = 0;
  for (const group of groups.slice(first, start)) {
    if (!kept(group)) continue;
    selected.delete(group);
    dropped += group.tokens;
  }
  return dropped;
}
