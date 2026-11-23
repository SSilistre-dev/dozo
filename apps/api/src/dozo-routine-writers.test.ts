import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routineWriterFor, saveRoutineNoted } from "./dozo-routine-writers.js";

const actor = (userId: string): Actor => ({
  userId,
  spaceId: "space-1",
  email: "someone@example.test",
  isDeploymentOwner: false,
});
const bot = { userId: "owner-1" };
const routine = { id: "routine-1", spaceId: "space-1" };

describe("routineWriterFor", () => {
  it("records whoever sends the prompt: the bot's owner as owner, anyone else as a member", () => {
    expect(routineWriterFor(actor("owner-1"), bot, { prompt: "Same as before" })).toBe("owner");
    expect(routineWriterFor(actor("guest-1"), bot, { prompt: "Same as before" })).toBe("member");
  });

  it("leaves the record alone when no text that reaches the model is sent", () => {
    for (const someone of ["owner-1", "member-1"]) {
      // As the route's input has it: every field optional, the prompt left out.
      const pause: { prompt?: string; active: boolean; crons: string[] } = {
        active: false,
        crons: ["0 8 * * *"],
      };
      expect(routineWriterFor(actor(someone), bot, pause)).toBeUndefined();
      expect(routineWriterFor(actor(someone), bot, {})).toBeUndefined();
    }
  });

  it("lets a member's name or watch make it theirs, but not the owner's: the prompt stays whoever wrote it", () => {
    for (const sent of [{ name: "Digest" }, { watch: null }, { watch: { kind: "files" } }]) {
      expect(routineWriterFor(actor("member-1"), bot, sent)).toBe("member");
      expect(routineWriterFor(actor("owner-1"), bot, sent)).toBeUndefined();
    }
  });
});

function fakeDb(failRecord = false) {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`record ${values.join(" ")}`);
      return failRecord ? Promise.reject(new Error("db down")) : Promise.resolve(1);
    }),
  };
  const $transaction = vi.fn(async (work: (db: typeof tx) => Promise<unknown>) => {
    calls.push("begin");
    try {
      const result = await work(tx);
      calls.push("commit");
      return result;
    } catch (error) {
      calls.push("rollback");
      throw error;
    }
  });
  const db = { $transaction, ...tx } as unknown as PrismaClient;
  return { db, calls, $transaction };
}

describe("saveRoutineNoted", () => {
  it("records the writer in the same transaction as the save", async () => {
    const { db, calls } = fakeDb();
    const write = vi.fn(async () => {
      calls.push("save");
      return routine;
    });
    await expect(saveRoutineNoted(db, "owner", write)).resolves.toBe(routine);
    expect(calls).toEqual(["begin", "save", "record owner routine-1 space-1", "commit"]);
  });

  it("fails the save when the record cannot be written, so no older record outlives the text", async () => {
    const { db, calls } = fakeDb(true);
    const write = async () => {
      calls.push("save");
      return routine;
    };
    await expect(saveRoutineNoted(db, "member", write)).rejects.toThrow("db down");
    expect(calls).toEqual(["begin", "save", "record member routine-1 space-1", "rollback"]);
  });

  it("saves as before, with no transaction or record, when there is no writer to record", async () => {
    const { db, calls, $transaction } = fakeDb();
    const write = vi.fn(async (given: unknown) => {
      expect(given).toBe(db);
      return routine;
    });
    await expect(saveRoutineNoted(db, undefined, write)).resolves.toBe(routine);
    expect($transaction).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
