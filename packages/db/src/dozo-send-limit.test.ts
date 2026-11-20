import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { readDozoDailySends, saveDozoDailySends, takeDozoDailySend } from "./dozo-send-limit.js";

/** Answers each query with the next of `answers`; statements answer nothing. */
function fakeDb(...answers: unknown[][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record =
    (query: boolean) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return Promise.resolve(query ? (answers.shift() ?? []) : 0);
    };
  const db = { $queryRaw: vi.fn(record(true)), $executeRaw: vi.fn(record(false)) };
  return { db: db as unknown as Prisma.TransactionClient, calls };
}

const send = { userId: "user-1", botId: "bot-1", sends: 1 };

describe("readDozoDailySends and saveDozoDailySends", () => {
  it("read the account's number, or the default without one", async () => {
    expect(await readDozoDailySends(fakeDb([{ dailySends: 10 }]).db, "user-1")).toBe(10);
    expect(await readDozoDailySends(fakeDb([]).db, "user-1")).toBe(50);
  });

  it("save one number per account", async () => {
    const { db, calls } = fakeDb();
    await saveDozoDailySends(db, "user-1", 25);
    expect(calls[0]!.sql).toContain('ON CONFLICT ("userId") DO UPDATE');
    expect(calls[0]!.values).toEqual(["user-1", 25]);
  });
});

describe("takeDozoDailySend", () => {
  it("counts on today's date in the member's timezone, below the account's number", async () => {
    const { db, calls } = fakeDb(
      [{ timezone: "Pacific/Auckland", dailySends: 10 }],
      [{ count: 3 }],
    );
    // 20:00 UTC on 1 March is already 2 March in Auckland.
    expect(await takeDozoDailySend(db, send, new Date("2027-03-01T20:00:00Z"))).toEqual({
      full: false,
    });
    const [, cleanup, upsert] = calls;
    expect(cleanup!.sql).toContain("DELETE FROM dozo_daily_sends");
    expect(cleanup!.values).toEqual(["user-1", "bot-1", "2027-03-02"]);
    expect(upsert!.sql).toContain("WHERE dozo_daily_sends.count + ? <= ?");
    expect(upsert!.values).toEqual(["user-1", "bot-1", "2027-03-02", 1, 1, 10, 1, 1, 10]);
  });

  it("is full when the upsert counts nothing, and names the number", async () => {
    const { db } = fakeDb([{ timezone: null, dailySends: null }], []);
    expect(await takeDozoDailySend(db, send)).toEqual({ full: true, dailySends: 50 });
  });

  it("reads an unset or unknown timezone as UTC", async () => {
    for (const timezone of [null, "Not/AZone"]) {
      const { db, calls } = fakeDb([{ timezone, dailySends: 5 }], [{ count: 1 }]);
      await takeDozoDailySend(db, send, new Date("2027-03-01T20:00:00Z"));
      expect(calls[2]!.values[2]).toBe("2027-03-01");
    }
    const missing = fakeDb([], [{ count: 1 }]);
    await takeDozoDailySend(missing.db, send, new Date("2027-03-01T20:00:00Z"));
    expect(missing.calls[2]!.values.slice(0, 3)).toEqual(["user-1", "bot-1", "2027-03-01"]);
    expect(missing.calls[2]!.values.at(-1)).toBe(50);
  });
});
