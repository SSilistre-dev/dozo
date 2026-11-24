import { runContinueJob } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type * as DbModule from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { ComputerBusyError } from "./computer-lifecycle.js";
import { requeueBehindComputerLock } from "./dozo-computer-lock-wait.js";
import { createRunExecutor } from "./executor.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

const acquire = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  settleReleasedTakeoverCards: vi.fn(),
}));
vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: acquire,
}));

type Run = { id: string; botId: string; status: string; checkpoint: string | null };
type Where = { id?: string | { not: string }; status?: string; botId?: string };

/**
 * One bot, one computer, the run holding it and the run that found it held. The requeue's
 * write is held open so a test can let the release land between the check and the requeue.
 */
function world(waitingStatus = "running") {
  const lock = { computerId: "computer-1", botId: "bot-1" };
  const lease = { ...lock, runId: "holder", expiresAt: new Date(Date.now() + 60_000) };
  const runs: Run[] = [
    { id: "holder", botId: "bot-1", status: "running", checkpoint: null },
    { id: "waiting", botId: "bot-1", status: waitingStatus, checkpoint: null },
  ];
  const requeueWrite = deferred();
  const requeueStarted = deferred();
  const matches = (run: Run, where: Where) =>
    (typeof where.id === "string" ? run.id === where.id : run.id !== where.id?.not) &&
    (where.status === undefined || run.status === where.status) &&
    (where.botId === undefined || run.botId === where.botId);
  const prisma = {
    run: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const run = runs.find((candidate) => matches(candidate, where));
        return run ? { id: run.id } : null;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; checkpoint: unknown }; data: Run }) => {
          // Only the plain requeue (no takeover checkpoint) applies to this run.
          if (where.checkpoint !== null) return { count: 0 };
          requeueStarted.resolve();
          await requeueWrite.promise;
          const run = runs.find((candidate) => candidate.id === where.id);
          if (run) run.status = data.status;
          return { count: run ? 1 : 0 };
        },
      ),
    },
    computerExecutionLease: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            computerId: string;
            botId: string;
            runId: { not: string };
            expiresAt: { gt: Date };
          };
        }) =>
          lease.computerId === where.computerId &&
          lease.botId === where.botId &&
          lease.runId !== where.runId.not &&
          lease.expiresAt > where.expiresAt.gt
            ? { id: "lease-1" }
            : null,
      ),
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = { prisma, jobs: { enqueue } } as unknown as ExecutorDeps;
  const release = async () => {
    lease.expiresAt = new Date(0);
    const holder = runs.find((run) => run.id === "holder");
    if (holder) holder.status = "completed";
    await startNextWaitingRun(deps, "bot-1", "holder");
  };
  return { lock, deps, enqueue, requeueWrite, requeueStarted, release };
}

describe("a run waiting for its bot's computer", () => {
  it("is woken when the release lands between its check and its requeue", async () => {
    const w = world();
    const parked = requeueBehindComputerLock(
      w.deps,
      w.lock,
      "waiting",
      "worker",
      3,
      null,
      false,
      true,
    );
    await w.requeueStarted.promise;
    // The release finds no queued run yet: the waiting run is still marked running.
    await w.release();
    expect(w.enqueue).not.toHaveBeenCalled();
    w.requeueWrite.resolve();
    await parked;
    expect(w.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
  });

  it("keeps waiting for the release while the computer is still held", async () => {
    const w = world();
    w.requeueWrite.resolve();
    await requeueBehindComputerLock(w.deps, w.lock, "waiting", "worker", 3, null, false, true);
    expect(w.enqueue).not.toHaveBeenCalled();
  });

  it("logs and ignores a failed lock re-read after the requeue committed", async () => {
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    try {
      const w = world();
      w.requeueWrite.resolve();
      vi.mocked(w.deps.prisma.computerExecutionLease.findFirst).mockRejectedValueOnce(
        new Error("connection reset"),
      );
      await expect(
        requeueBehindComputerLock(w.deps, w.lock, "waiting", "worker", 3, null, false, true),
      ).resolves.toBeUndefined();
      expect(w.deps.prisma.run.updateMany).toHaveBeenCalled();
      expect(w.enqueue).not.toHaveBeenCalled();
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        level: "warn",
        message: "best effort failed: computer lock re-read",
      });
    } finally {
      installLogger(previous);
    }
  });

  it("leaves a run with a retry timer to its timer", async () => {
    const w = world();
    w.requeueWrite.resolve();
    await requeueBehindComputerLock(w.deps, w.lock, "waiting", "worker", 3, null, false, false);
    expect(w.deps.prisma.computerExecutionLease.findFirst).not.toHaveBeenCalled();
    expect(w.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...runContinueJob("waiting"), availableAt: expect.any(Date) }),
    );
  });

  it("leaves a run waiting for its person alone when the computer is free", async () => {
    const w = world();
    const parked = requeueBehindComputerLock(
      w.deps,
      w.lock,
      "waiting",
      "worker",
      3,
      null,
      true,
      true,
    );
    await w.requeueStarted.promise;
    await w.release();
    w.requeueWrite.resolve();
    await parked;
    expect(w.enqueue).not.toHaveBeenCalled();
  });
});

describe("the run executor", () => {
  it("reads its bot's computer lock again after a busy claim puts the run back in line", async () => {
    acquire.mockRejectedValue(new ComputerBusyError());
    const run = {
      id: "run-1",
      spaceId: "space-1",
      botId: "bot-1",
      status: "queued",
      leaseFence: 0,
      checkpoint: null,
      startedAt: null,
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => null) },
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased" })),
        findFirst: vi.fn(async () => ({ id: "run-1" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          computerId: "computer-1",
          computerSwitching: false,
          computer: { scope: "team" },
        })),
      },
      // Held when the claim checks, released by the time the run is back in line.
      computerExecutionLease: {
        findFirst: vi
          .fn(async (): Promise<{ id: string } | null> => null)
          .mockResolvedValueOnce({ id: "lease-of-run-0" }),
      },
    };
    const enqueue = vi.fn(async () => undefined);
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue },
      events: { publishSpaceChange: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.continueRun("run-1", "worker-1");
    expect(prisma.computerExecutionLease.findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ computerId: "computer-1", botId: "bot-1" }),
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("run-1"));
  });
});
