import type * as DbModule from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computers/computer-lifecycle.js";
import { ComputerBusyError } from "./computers/computer-lifecycle.js";
import { createRunExecutor } from "./runs/executor/executor.js";

const leases = vi.hoisted(() => ({ acquire: vi.fn(), dedicated: vi.fn(), release: vi.fn() }));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  settleReleasedTakeoverCards: vi.fn(),
}));
vi.mock("./computers/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: leases.acquire,
  acquireDedicatedScreenLeaseFence: leases.dedicated,
  releaseComputerExecutionLease: leases.release,
}));

/**
 * The line of waiting work is re-read when the Space signals a change in its runs. A claim signals
 * before the computer turns out to be held, so the run going back in line has to signal again.
 */
function fixture() {
  const run = {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    status: "queued",
    leaseFence: 0,
    checkpoint: null,
    startedAt: null,
  };
  const order: string[] = [];
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased" })),
      updateMany: vi.fn(async () => {
        order.push("requeue");
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        computerId: "computer-1",
        computerSwitching: false,
        computer: { scope: "team" },
      })),
    },
    computerExecutionLease: { findFirst: vi.fn(async () => ({ id: "lease-of-run-0" })) },
    attempt: { create: vi.fn(async () => Promise.reject(new Error("attempt setup failed"))) },
  };
  const publishSpaceChange = vi.fn(async (_spaceId: string, kind: string) => {
    order.push(`signal:${kind}`);
  });
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue: vi.fn() },
    events: { publishSpaceChange },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { order, publishSpaceChange, start: () => executor.continueRun("run-1", "worker-1") };
}

describe("a run that finds its computer held", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signals that the Space's runs changed after it goes back in line", async () => {
    leases.acquire.mockRejectedValue(new ComputerBusyError());
    const { order, publishSpaceChange, start } = fixture();
    await start();
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
    expect(order.at(-1)).toBe("signal:runs");
    expect(order.lastIndexOf("signal:runs")).toBeGreaterThan(order.indexOf("requeue"));
  });
});
