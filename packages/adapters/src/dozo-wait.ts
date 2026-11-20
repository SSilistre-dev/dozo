import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatchState } from "@rakazo/contracts";
import { bestEffort, getLogger } from "@rakazo/logging";
import { DOZO_ROUTINE_CATCH_UP_MS } from "./dozo-quiet-hours.js";
import { DOZO_WAIT_CHANGED_NOTE, dozoWaitTimedOutNote } from "./dozo-wait.prompt.js";
import { DOZO_WAIT_MAX_MINUTES, DOZO_WAIT_MIN_MINUTES } from "./dozo-wait.tool-definition.js";
import type { tickRoutineWatch } from "./routine-watch.js";
import {
  describeRoutineWatch,
  parseRoutineWatch,
  parseRoutineWatchState,
} from "./routine-watch.js";
import type { createScheduleFromTool } from "./schedule-tools.js";

/**
 * A one-time wait is a watching routine with a row here: it wakes its bot once, at the first
 * change or at `endsAt`, and then ends. Between checks nothing runs and nothing is held in
 * memory; the routine's wakeup job carries it across restarts.
 */

/** Waits a bot may have going at once, inside the limit on its active routines. */
export const DOZO_MAX_WAITS_PER_BOT = 10;

type CreateSchedule = typeof createScheduleFromTool;
type CreateDeps = Parameters<CreateSchedule>[0];
type CreateInput = Parameters<CreateSchedule>[1];

/** The minutes asked for; undefined when no wait is asked for. */
function readWaitMinutes(value: unknown): number | undefined | { error: string } {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim()))
    return undefined;
  const minutes = Math.round(Number(value));
  if (
    !Number.isFinite(minutes) ||
    minutes < DOZO_WAIT_MIN_MINUTES ||
    minutes > DOZO_WAIT_MAX_MINUTES
  )
    return {
      error: `waitMinutes must be ${DOZO_WAIT_MIN_MINUTES} to ${DOZO_WAIT_MAX_MINUTES} minutes.`,
    };
  return minutes;
}

/** schedule_create, which becomes a one-time wait when the call gives `waitMinutes`. */
export async function dozoCreateSchedule(
  create: CreateSchedule,
  rawMinutes: unknown,
  deps: CreateDeps,
  input: CreateInput,
) {
  const minutes = readWaitMinutes(rawMinutes);
  if (minutes === undefined) return create(deps, input);
  if (typeof minutes !== "number") return minutes;
  if (input.schedule.watch === undefined)
    return {
      error: "waitMinutes goes with a watch. To wait a set time, use delayMinutes or runAt.",
    };
  const botId = input.target?.botId ?? input.botId;
  const [counted] = await deps.prisma.$queryRaw<Array<{ waits: number }>>`
    SELECT count(*)::int AS waits FROM dozo_routine_waits w JOIN routines r ON r.id = w."routineId"
    WHERE r."botId" = ${botId} AND r.active`;
  if ((counted?.waits ?? 0) >= DOZO_MAX_WAITS_PER_BOT)
    return {
      error: `You already have ${DOZO_MAX_WAITS_PER_BOT} waits going. Cancel one with schedule_cancel before adding another.`,
    };
  const created = await create(deps, input);
  const routineId = "ok" in created ? created.routineId : undefined;
  if (!routineId) return created;
  const endsAt = new Date(Date.now() + minutes * 60_000);
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO dozo_routine_waits ("routineId", "endsAt", minutes)
      VALUES (${routineId}, ${endsAt.toISOString()}::timestamptz, ${minutes})`;
  } catch (error) {
    // Without its row the watch would repeat for good: take it back.
    getLogger().warn("routine.wait_failed", { "routine.id": routineId, error });
    await deps.prisma.routine.updateMany({
      where: { id: routineId },
      data: { active: false, nextRunAt: null },
    });
    await bestEffort("wait job", deps.jobs.cancel(routineJobKey(routineId)));
    await bestEffort("wait change", deps.events.publishSpaceChange?.(input.spaceId, "routines"));
    return { error: "Could not start the wait. Try again." };
  }
  return {
    ...created,
    waitEndsAt: endsAt.toISOString(),
    note: "Wakes you once, in this chat, at the first change or at waitEndsAt, then ends. End your turn now.",
  };
}

type Tick = typeof tickRoutineWatch;
export type DozoWaitTick = Awaited<ReturnType<Tick>> & { ends?: boolean };

/**
 * One wake of a watching routine. A routine that is no wait is checked as always. A wait is
 * checked until its deadline and ends with the run a change starts; at the deadline it runs
 * once more without a check to say nothing changed. A deadline missed by more than the catch-up
 * window ends the wait without a run, as a missed one-time routine ends.
 */
export async function dozoTickWait(
  tick: Tick,
  ...[deps, routine, target, scheduledAt]: Parameters<Tick>
): Promise<DozoWaitTick> {
  const [wait] = await deps.prisma.$queryRaw<Array<{ endsAt: Date; minutes: number }>>`
    SELECT "endsAt", minutes FROM dozo_routine_waits WHERE "routineId" = ${routine.id}`;
  if (!wait) return tick(deps, routine, target, scheduledAt);
  const now = Date.now();
  if (now < wait.endsAt.getTime()) {
    const result = await tick(deps, routine, target, scheduledAt);
    if (result.run) return { ...result, note: result.note + DOZO_WAIT_CHANGED_NOTE, ends: true };
    // A next check past the deadline would end the wait late: wake at the deadline instead.
    const moved = await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: { gt: wait.endsAt } },
      data: { nextRunAt: wait.endsAt },
    });
    if (moved.count === 1) await deps.jobs.enqueue(routineWakeupJob(routine.id, wait.endsAt));
    return result;
  }
  if (now - wait.endsAt.getTime() > DOZO_ROUTINE_CATCH_UP_MS) {
    const ended = await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { active: false, nextRunAt: null },
    });
    if (ended.count === 1) {
      getLogger().info("routine.missed", {
        "routine.id": routine.id,
        "routine.due_at": wait.endsAt.toISOString(),
      });
      await bestEffort("wait ended", deps.events.publishSpaceChange?.(routine.spaceId, "routines"));
    }
    return { run: false };
  }
  const watch = parseRoutineWatch(routine.watch);
  const state: RoutineWatchState = parseRoutineWatchState(routine.watchState) ?? {
    checkedAt: new Date(now).toISOString(),
    outcome: "unchanged",
    fingerprint: null,
    detail: null,
  };
  return {
    run: true,
    state,
    nextRunAt: new Date(now),
    note: dozoWaitTimedOutNote(watch ? describeRoutineWatch(watch) : "a watch", wait.minutes),
    ends: true,
  };
}

/** Where a watching routine goes after the run it just started: nowhere once a wait has ended. */
export function dozoWatchNextRunAt(tick: { nextRunAt: Date; ends?: boolean }): Date | null {
  return tick.ends ? null : tick.nextRunAt;
}
