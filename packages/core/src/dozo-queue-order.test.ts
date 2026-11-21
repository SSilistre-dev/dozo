import { describe, expect, it } from "vitest";
import { compareQueueStart, queueStartOrder } from "./dozo-queue-order.js";

type Row = { id: string; createdAt: Date };

/** What a database does with an `orderBy` list of ascending keys: the first that differs decides. */
function sortedBy(rows: Row[], order: ReadonlyArray<Partial<Record<keyof Row, "asc">>>) {
  return [...rows].sort((a, b) => {
    for (const key of order.flatMap((entry) => Object.keys(entry) as Array<keyof Row>)) {
      const left = a[key];
      const right = b[key];
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  });
}

describe("the order work waiting for a bot starts in", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, 0, ms));
  const rows: Row[] = [
    { id: "c", createdAt: at(5) },
    { id: "b", createdAt: at(1) },
    { id: "z", createdAt: at(1) },
    { id: "a", createdAt: at(9) },
    { id: "d", createdAt: at(1) },
  ];

  it("is oldest first, then by id", () => {
    expect(queueStartOrder()).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("is the same whether the database sorts by the key list or the line sorts by the comparator", () => {
    const expected = ["b", "d", "z", "c", "a"];
    expect(sortedBy(rows, queueStartOrder()).map((row) => row.id)).toEqual(expected);
    expect([...rows].sort(compareQueueStart).map((row) => row.id)).toEqual(expected);
  });

  it("gives a fresh list each time, so no caller can change what another reads", () => {
    queueStartOrder().pop();
    expect(queueStartOrder()).toHaveLength(2);
  });
});
