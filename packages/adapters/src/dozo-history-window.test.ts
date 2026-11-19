import { describe, expect, it } from "vitest";
import { alignHistoryStart, startsHistoryWindow } from "./dozo-history-window.js";

type Message = { role: string; content: string };

const exchange = (n: number): Message[] => [
  { role: "user", content: `question ${n}` },
  { role: "assistant", content: `answer ${n}` },
];
const conversation = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => exchange(from + i)).flat();
const groupsOf = (messages: Message[]) => messages.map((_, i) => ({ indexes: [i], tokens: 10 }));

/** The first kept message after the oldest `cut` messages were dropped by the budget. */
function windowStart(messages: Message[], cut: number, keepExchanges = 2) {
  const groups = groupsOf(messages);
  const selected = new Set(groups.slice(cut));
  const dropped = alignHistoryStart(
    messages,
    groups,
    selected,
    new Set(),
    messages.length,
    keepExchanges,
  );
  const first = groups.find((group) => selected.has(group))!;
  return { first: messages[first.indexes[0]!]!, dropped, kept: selected.size };
}

describe("stable start of a cut history", () => {
  it("picks window starts by content: only user messages, about one in four", () => {
    const users = conversation(1, 400).filter((m) => m.role === "user");
    const starts = users.filter(startsHistoryWindow).length;
    expect(starts).toBeGreaterThan(60);
    expect(starts).toBeLessThan(140);
    expect(startsHistoryWindow({ role: "assistant", content: "question 1" })).toBe(false);
    expect(startsHistoryWindow({ role: "user" })).toBe(startsHistoryWindow({ role: "user" }));
  });

  it("keeps the same first message while the cut moves by one exchange per turn", () => {
    const firsts = [0, 1, 2, 3, 4, 5].map(
      (turn) => windowStart(conversation(1 + turn, 60 + turn), 20).first,
    );
    expect(new Set(firsts.map((m) => m.content)).size).toBeLessThan(4);
    for (const first of firsts) expect(startsHistoryWindow(first)).toBe(true);
  });

  it("drops nothing when no history was cut, and never the recent exchanges", () => {
    const messages = conversation(1, 10);
    expect(windowStart(messages, 0).dropped).toBe(0);
    const short = windowStart(messages, 18, 1);
    expect(short.dropped).toBe(0);
    expect(short.kept).toBe(2);
  });

  it("keeps protected groups while dropping the ones before the start", () => {
    const messages = conversation(1, 60);
    const groups = groupsOf(messages);
    const selected = new Set(groups.slice(20));
    const start = groups.findIndex(
      (group, i) => i > 21 && startsHistoryWindow(messages[group.indexes[0]!]!),
    );
    const dropped = alignHistoryStart(messages, groups, selected, new Set([21]), 120, 2);
    expect(selected.has(groups[21]!)).toBe(true);
    expect(selected.has(groups[start]!)).toBe(true);
    expect(dropped).toBe((start - 20 - 1) * 10);
  });
});
