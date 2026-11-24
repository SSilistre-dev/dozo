import { expect, it, vi } from "vitest";
import { cancelDeactivatedAccountRuns } from "./account-status.js";
import type { PrismaClient } from "./client.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

// Runs on the branded tree only: the transaction options are a brand rule on account-status.ts.

/**
 * Cancelling a deactivated account's runs locks each chat's row before it writes, and other work
 * holds that lock for seconds, so it gets the body budget the other thread-locking transactions
 * share instead of Prisma's 5 s default, which under load expired it (P2028) into a server error.
 * A timing reproduction would hold a real lock past 5 s; the options the transaction is opened
 * with are what this change sets, so that is what is held here.
 */
it("opens each chat's cancellation with the shared thread-lock budget", async () => {
  const stop = new Error("transaction body not run here");
  const $transaction = vi.fn(async () => Promise.reject(stop));
  const prisma = {
    $transaction,
    run: { findMany: vi.fn(async () => [{ threadId: "thread-1" }]) },
  } as unknown as PrismaClient;
  await expect(cancelDeactivatedAccountRuns(prisma, { notify: vi.fn() }, "user-1")).rejects.toBe(
    stop,
  );
  expect($transaction).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    THREAD_LOCK_TRANSACTION_OPTIONS,
  );
});
