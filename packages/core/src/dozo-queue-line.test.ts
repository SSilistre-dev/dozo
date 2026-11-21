import type { DozoQueueItem } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { QUEUE_LIST_ROWS, queueLine, queueRows } from "./dozo-queue-line.js";

const words = { waiting: "Waiting in line…", after: (name: string) => `After ${name}` };

const item = (over: Partial<DozoQueueItem>): DozoQueueItem => ({
  id: "run-1",
  kind: "run",
  botId: "bot-1",
  position: 1,
  mine: true,
  reason: "bot_busy",
  waitingFor: null,
  label: null,
  ...over,
});

describe("queueLine", () => {
  it("is null while none of the caller's work waits", () => {
    expect(queueLine([], words)).toBeNull();
    expect(queueLine([item({ mine: false })], words)).toBeNull();
  });

  it("has no place for the only piece of work", () => {
    expect(queueLine([item({})], words)).toBe("Waiting in line…");
  });

  it("gives the place when others wait for the same bot", () => {
    const line = queueLine([item({ id: "a", mine: false }), item({ id: "b", position: 2 })], words);
    expect(line).toBe("Waiting in line… · #2");
  });

  it("does not count another bot's work as a place in the line", () => {
    const items = [item({ id: "a", botId: "bot-2", mine: false }), item({ id: "b" })];
    expect(queueLine(items, words)).toBe("Waiting in line…");
    expect(
      queueLine([...items, item({ id: "c", botId: "bot-1", position: 2, mine: false })], words),
    ).toBe("Waiting in line… · #1");
  });

  it("names a routine only for a message held behind it", () => {
    const held = item({ kind: "message", reason: "behind_run", waitingFor: "Weekly sums" });
    expect(queueLine([held], words)).toBe("Waiting in line… · After Weekly sums");
    expect(queueLine([item({ waitingFor: "Weekly sums" })], words)).toBe("Waiting in line…");
    expect(queueLine([{ ...held, waitingFor: null }], words)).toBe("Waiting in line…");
  });
});

describe("queueRows", () => {
  it("names the caller's work by its label and anyone else's as queued", () => {
    const { shown, hidden } = queueRows(
      [
        item({ id: "a", label: "Mine" }),
        item({ id: "b", mine: false, label: "Leak" }),
        item({ id: "c" }),
      ],
      "Queued",
    );
    expect(shown.map((row) => row.text)).toEqual(["Mine", "Queued", "Queued"]);
    expect(hidden).toBe(0);
  });

  it("folds what is past the limit into a count", () => {
    const many = Array.from({ length: QUEUE_LIST_ROWS + 3 }, (_, index) =>
      item({ id: `r${index}`, position: index + 1 }),
    );
    const { shown, hidden } = queueRows(many, "Queued");
    expect(shown).toHaveLength(QUEUE_LIST_ROWS);
    expect(hidden).toBe(3);
  });
});
