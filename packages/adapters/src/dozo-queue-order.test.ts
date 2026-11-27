import { compareQueueStart, queueStartOrder } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./runs/executor/executor-deps.js";
import { startNextWaitingRun } from "./runs/lifecycle/run-lifecycle.js";

/**
 * The line shown to people (`planQueue`) and the run that starts next are read from one order:
 * this holds the starting half to the shared key, and the planner's test holds the other half.
 */
it("starts the next waiting run in the order the line is drawn in", async () => {
  const findFirst = vi.fn(async () => null);
  const deps = { prisma: { run: { findFirst } }, jobs: { enqueue: vi.fn() } };
  await startNextWaitingRun(deps as unknown as ExecutorDeps, "bot", "finished");
  expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ orderBy: queueStartOrder() }));
});

it("starts the run the line shows first when a person's message and a routine wait together", async () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, 0, ms));
  // The routine is older, the person's message newer: the person's goes first.
  const waiting = [
    { id: "routine", trigger: "routine", createdAt: at(1) },
    { id: "person", trigger: "user", createdAt: at(9) },
  ];
  const findFirst = vi.fn(
    async (args: { where: { trigger?: { in: string[] } } }) =>
      waiting
        .filter((run) => !args.where.trigger || args.where.trigger.in.includes(run.trigger))
        .sort(compareQueueStart)[0] ?? null,
  );
  const enqueue = vi.fn();
  const deps = { prisma: { run: { findFirst } }, jobs: { enqueue } };
  await startNextWaitingRun(deps as unknown as ExecutorDeps, "bot", "finished");
  const shownFirst = [...waiting].sort(compareQueueStart)[0]?.id;
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: { runId: shownFirst } }));
  expect(shownFirst).toBe("person");
});
