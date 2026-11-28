import { deadlineSignal, withAbort } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

type AnnounceDeps = { prisma: PrismaClient; events: ThreadEvents };

/** How long the announcement's reads may take before it gives up; the start never waits on it. */
export const ANNOUNCE_READ_MS = 5_000;

/**
 * Starts a computer and then, when that start brought it up (its running clock began during the
 * start), tells every bot thread on it that it is running. A window opened while someone else (a
 * run, another tab) woke the computer learns it from that event and reads its screen. Nothing is
 * read before the start, the start's answer never waits for the announcement, and a failed or
 * timed-out announcement never fails the start.
 */
export async function announceWhenStarted<T>(
  deps: AnnounceDeps,
  computerId: string,
  start: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const started = await start();
  void bestEffort("announce computer running", announceRunning(deps, computerId, startedAt));
  return started;
}

/**
 * One content-light `computer.status` event per bot thread, only for a computer still running
 * whose clock began at `since` or later. A computer that was already running keeps its clock, so
 * it is never announced; a read past the deadline announces nothing.
 */
export async function announceRunning(
  deps: AnnounceDeps,
  computerId: string,
  since: Date,
  signal: AbortSignal = deadlineSignal(ANNOUNCE_READ_MS),
): Promise<void> {
  const computer = await withAbort(
    deps.prisma.computer.findUnique({
      where: { id: computerId },
      select: { state: true, spaceId: true, runningSince: true },
    }),
    signal,
  );
  if (computer?.state !== "running" || !computer.runningSince || computer.runningSince < since) {
    return;
  }
  const bots = await withAbort(
    deps.prisma.bot.findMany({
      where: { computerId },
      select: { id: true, thread: { select: { id: true } } },
    }),
    signal,
  );
  for (const bot of bots) {
    if (!bot.thread) continue;
    await deps.events.append({
      spaceId: computer.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.status",
      payload: { status: "running" },
    });
  }
}
