import { bestEffort } from "@rakazo/logging";
import type { ExecutorDeps } from "./runs/executor/executor-deps.js";
import { requeueComputerRun } from "./runs/lifecycle/run-lifecycle.js";
import type { TakeoverResumeCheckpoint } from "./runs/turn/takeover-resume.js";
import { wakeRun } from "./runs/wakeups/wake-run.js";

/**
 * `requeueComputerRun` for a run that found its bot's computer held. The run holding it starts
 * the next queued run when it lets go, but a release landing after this run's check and before
 * its requeue finds nothing queued yet, and the run would wait for the recovery sweep. So the lock
 * is read again once the run is back in line, and a free one starts it now. A lock still held, by
 * a live or an ended run, waits for its release or expiry: the claim could not take it either.
 */
export async function requeueBehindComputerLock(
  deps: ExecutorDeps,
  lock: { computerId: string; botId: string },
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover: boolean,
  untilReleased: boolean,
): Promise<void> {
  await requeueComputerRun(
    deps,
    runId,
    workerId,
    fence,
    resumeCheckpoint,
    heldForTakeover,
    untilReleased,
  );
  // Without `untilReleased` the run already has a retry timer.
  if (!untilReleased) return;
  // The requeue has committed: a failed re-read must not surface as a setup failure of the
  // run. The recovery sweep remains the backup.
  await bestEffort("computer lock re-read", wakeIfComputerFree(deps, lock, runId));
}

async function wakeIfComputerFree(
  deps: ExecutorDeps,
  lock: { computerId: string; botId: string },
  runId: string,
): Promise<void> {
  const held = await deps.prisma.computerExecutionLease.findFirst({
    where: { ...lock, runId: { not: runId }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (held) return;
  // Only a queued run is woken, as the release does: one waiting for its person stays put.
  const queued = await deps.prisma.run.findFirst({
    where: { id: runId, status: "queued" },
    select: { id: true },
  });
  if (queued) await wakeRun(deps.jobs, runId);
}
