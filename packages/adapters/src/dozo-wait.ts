import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatchState } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { dozoMeetingPrepRefusal } from "./dozo-meeting-prep-guard.js";
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

const TOO_MANY = `You already have ${DOZO_MAX_WAITS_PER_BOT} waits going. Cancel one with schedule_cancel before adding another.`;

/** The minutes asked for, why they cannot be used, or undefined when no wait is asked for. */
function readWaitMinutes(value: unknown): number | string | undefined {
  if (!given(value)) return undefined;
  const minutes = Math.round(Number(value));
  if (
    !Number.isFinite(minutes) ||
    minutes < DOZO_WAIT_MIN_MINUTES ||
    minutes > DOZO_WAIT_MAX_MINUTES
  )
    return `waitMinutes must be ${DOZO_WAIT_MIN_MINUTES} to ${DOZO_WAIT_MAX_MINUTES} minutes.`;
  return minutes;
}

/** Model serializers send an unused field as null or "". */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
}

async function waitsGoing(db: Pick<PrismaClient, "$queryRaw">, botId: string): Promise<number> {
  const [counted] = await db.$queryRaw<Array<{ waits: number }>>`
    SELECT count(*)::int AS waits FROM dozo_routine_waits w JOIN routines r ON r.id = w."routineId"
    WHERE r."botId" = ${botId} AND r.active`;
  return counted?.waits ?? 0;
}

async function waitRefusal(
  prisma: PrismaClient,
  botId: string,
  watch: unknown,
): Promise<string | undefined> {
  if (!given(watch))
    return "waitMinutes goes with a watch. To wait a set time, use delayMinutes or runAt.";
  return (await waitsGoing(prisma, botId)) >= DOZO_MAX_WAITS_PER_BOT ? TOO_MANY : undefined;
}

/**
 * Why a schedule_create call's wait cannot start. Asked before the approval gate as well, so a
 * wait that cannot start shows no approval card.
 */
export async function dozoWaitRefusal(
  prisma: PrismaClient,
  rawMinutes: unknown,
  input: { botId: string; watch: unknown },
): Promise<string | undefined> {
  const minutes = readWaitMinutes(rawMinutes);
  if (minutes === undefined) return undefined;
  if (typeof minutes === "string") return minutes;
  return waitRefusal(prisma, input.botId, input.watch);
}

/**
 * schedule_create, which becomes a one-time wait when the call gives `waitMinutes`, and which
 * holds a meeting prep reminder to its shape (dozo-meeting-prep-guard.ts).
 */
export async function dozoCreateSchedule(
  create: CreateSchedule,
  rawMinutes: unknown,
  deps: CreateDeps,
  input: CreateInput,
) {
  const guarded = await dozoMeetingPrepRefusal(deps.prisma, {
    ...input,
    botId: input.target?.botId ?? input.botId,
  });
  if (guarded) return { error: guarded };
  const minutes = readWaitMinutes(rawMinutes);
  if (minutes === undefined) return create(deps, input);
  if (typeof minutes === "string") return { error: minutes };
  const botId = input.target?.botId ?? input.botId;
  const refused = await waitRefusal(deps.prisma, botId, input.schedule.watch);
  if (refused) return { error: refused };
  const created = await create(deps, input);
  const routineId = "ok" in created ? created.routineId : undefined;
  if (!routineId) return created;
  const endsAt = new Date(Date.now() + minutes * 60_000);
  // Without its row the watch would repeat for good: take it back.
  const takeBack = async (error: string) => {
    await deps.prisma.routine.updateMany({
      where: { id: routineId },
      data: { active: false, nextRunAt: null },
    });
    await bestEffort("wait job", deps.jobs.cancel(routineJobKey(routineId)));
    await bestEffort("wait change", deps.events.publishSpaceChange?.(input.spaceId, "routines"));
    return { error };
  };
  let recorded: boolean;
  try {
    recorded = await deps.prisma.$transaction(async (tx) => {
      // A bot's waits are counted and added one at a time, so two calls cannot both take the last.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`dozo-wait:${botId}`}, 0))::text AS "lock"`;
      if ((await waitsGoing(tx, botId)) >= DOZO_MAX_WAITS_PER_BOT) return false;
      await tx.$executeRaw`
        INSERT INTO dozo_routine_waits ("routineId", "endsAt", minutes)
        VALUES (${routineId}, ${endsAt.toISOString()}::timestamptz, ${minutes})`;
      return true;
    });
  } catch (error) {
    getLogger().warn("routine.wait_failed", { "routine.id": routineId, error });
    return takeBack("Could not start the wait. Try again.");
  }
  if (!recorded) return takeBack(TOO_MANY);
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
    SELECT "endsAt" AT TIME ZONE 'UTC' AS "endsAt", minutes
    FROM dozo_routine_waits WHERE "routineId" = ${routine.id}`;
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
