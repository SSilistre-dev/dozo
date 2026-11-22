import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { noteRoutineSaved } from "./dozo-routine-writers.js";

const actor = (userId: string): Actor => ({
  userId,
  spaceId: "space-1",
  email: "someone@example.test",
  isDeploymentOwner: false,
});
const routine = { id: "routine-1", spaceId: "space-1" };

function fakeDb(fail = false) {
  const values: unknown[][] = [];
  const $executeRaw = vi.fn((_strings: TemplateStringsArray, ...v: unknown[]) => {
    values.push(v);
    return fail ? Promise.reject(new Error("db down")) : Promise.resolve(1);
  });
  const db = { $executeRaw, $queryRaw: vi.fn() } as unknown as Pick<
    PrismaClient,
    "$queryRaw" | "$executeRaw"
  >;
  return { db, values };
}

describe("noteRoutineSaved", () => {
  it("records the bot's owner as owner", async () => {
    const { db, values } = fakeDb();
    await noteRoutineSaved(db, actor("owner-1"), { userId: "owner-1" }, routine);
    expect(values).toEqual([["owner", "routine-1", "space-1"]]);
  });

  it("records anyone else as a member", async () => {
    const { db, values } = fakeDb();
    await noteRoutineSaved(db, actor("guest-1"), { userId: "owner-1" }, routine);
    expect(values).toEqual([["member", "routine-1", "space-1"]]);
  });

  it("does not fail the save when the record is lost", async () => {
    const { db, values } = fakeDb(true);
    await expect(
      noteRoutineSaved(db, actor("owner-1"), { userId: "owner-1" }, routine),
    ).resolves.toBeUndefined();
    expect(values).toHaveLength(1);
  });
});
