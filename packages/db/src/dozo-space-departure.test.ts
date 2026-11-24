import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { leaveSpace, removeSpaceMember } from "./space-members.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

// Runs on the branded tree only: the transaction options are a brand rule on space-members.ts.

/**
 * Taking someone out of a Space cancels their runs and writes to each chat they had running, so it
 * locks chat rows other work holds for seconds. It gets the body budget those transactions share
 * instead of Prisma's 5 s default, which under load expired it (P2028) and failed the removal.
 * A timing reproduction would hold a real lock past 5 s and depend on machine speed; the options
 * the transaction is opened with are what this change sets, so that is what is held here.
 */
function space() {
  const stop = new Error("transaction body not run here");
  const $transaction = vi.fn(async () => Promise.reject(stop));
  const prisma = {
    $transaction,
    spaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { spaceId_userId: { userId: string } } }) => ({
        role: where.spaceId_userId.userId === "owner-1" ? "owner" : "member",
      })),
    },
  } as unknown as PrismaClient;
  return { prisma, $transaction, stop };
}

const departureOptions = {
  ...THREAD_LOCK_TRANSACTION_OPTIONS,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

describe("a person departing a Space", () => {
  it("opens the departure with the shared thread-lock budget when they leave", async () => {
    const s = space();
    await expect(leaveSpace(s.prisma, { spaceId: "space-1", userId: "member-1" })).rejects.toBe(
      s.stop,
    );
    expect(s.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), departureOptions);
  });

  it("opens the departure with the same budget when the owner removes them", async () => {
    const s = space();
    await expect(
      removeSpaceMember(s.prisma, {
        spaceId: "space-1",
        userId: "owner-1",
        memberUserId: "member-1",
      }),
    ).rejects.toBe(s.stop);
    expect(s.$transaction).toHaveBeenLastCalledWith(expect.any(Function), departureOptions);
  });
});
