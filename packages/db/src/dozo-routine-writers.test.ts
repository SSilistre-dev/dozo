import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./database/client.js";
import { readRoutineWriter, recordRoutineWriter } from "./dozo-routine-writers.js";

function fakeDb(answer: unknown = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?"), values });
    return Promise.resolve(answer);
  };
  const db = { $queryRaw: vi.fn(record), $executeRaw: vi.fn(record) };
  return { db: db as unknown as Prisma.TransactionClient, calls };
}

describe("recordRoutineWriter", () => {
  it("upserts the writer for a routine of that space, keyed on the routine", async () => {
    const { db, calls } = fakeDb();
    await recordRoutineWriter(db, { routineId: "routine-1", spaceId: "space-1" }, "member");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["member", "routine-1", "space-1"]);
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain('INSERT INTO "dozo_routine_writers"');
    expect(sql).toContain('r."spaceId" = ?');
    expect(sql).toContain('ON CONFLICT ("routineId") DO UPDATE');
  });

  it("lets a failed write reach the caller", async () => {
    const db = {
      $executeRaw: vi.fn().mockRejectedValue(new Error("down")),
      $queryRaw: vi.fn(),
    } as unknown as Prisma.TransactionClient;
    await expect(
      recordRoutineWriter(db, { routineId: "routine-1", spaceId: "space-1" }, "owner"),
    ).rejects.toThrow("down");
  });
});

describe("readRoutineWriter", () => {
  it("returns the recorded writer and time for the routine", async () => {
    const writtenAt = new Date("2026-11-21T10:00:00Z");
    const { db, calls } = fakeDb([{ writer: "owner", writtenAt }]);
    await expect(readRoutineWriter(db, "routine-1")).resolves.toEqual({
      writer: "owner",
      writtenAt,
    });
    expect(calls[0]?.values).toEqual(["routine-1"]);
  });

  it("returns undefined when nothing was recorded", async () => {
    const { db } = fakeDb([]);
    await expect(readRoutineWriter(db, "routine-2")).resolves.toBeUndefined();
  });
});
