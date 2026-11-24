import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

type AnnounceDeps = { prisma: PrismaClient; events: ThreadEvents };

/**
 * Starts a computer and, when it was not running before, tells every bot thread on it that it is
 * running now. A window opened while someone else (a run, another tab) woke the computer learns it
 * from that event and reads its screen. The start's answer never waits for the announcement, and
 * a failed announcement never fails the start.
 */
export async function announceWhenStarted<T>(
  deps: AnnounceDeps,
  computerId: string,
  start: () => Promise<T>,
): Promise<T> {
  const before = await bestEffort(
    "read computer state before start",
    (async () =>
      deps.prisma.computer.findUnique({ where: { id: computerId }, select: { state: true } }))(),
  );
  const started = await start();
  if (before?.state !== "running") {
    void bestEffort("announce computer running", announceRunning(deps, computerId));
  }
  return started;
}

/** One content-light `computer.status` event per bot thread, only while it is still running. */
export async function announceRunning(deps: AnnounceDeps, computerId: string): Promise<void> {
  const computer = await deps.prisma.computer.findUnique({
    where: { id: computerId },
    select: { state: true, spaceId: true },
  });
  if (computer?.state !== "running") return;
  const bots = await deps.prisma.bot.findMany({
    where: { computerId },
    select: { id: true, thread: { select: { id: true } } },
  });
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
