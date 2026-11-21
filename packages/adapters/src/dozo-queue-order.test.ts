import { queueStartOrder } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

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
