import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { isOneShotRoutineCrons, nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

/** A missed scheduled run still starts when it is at most this late, once; older ones are skipped. */
export const DOZO_ROUTINE_CATCH_UP_MS = 12 * 60 * 60_000;

const DAY_MINUTES = 24 * 60;

/** One daily range of local minutes, `startMinute` included and `endMinute` not, across midnight when it ends earlier. */
export interface DozoQuietHours {
  startMinute: number;
  endMinute: number;
}

const minuteFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes past local midnight; an unknown zone counts as UTC. */
function localMinute(at: Date, timeZone: string): number {
  let format = minuteFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      return localMinute(at, "UTC");
    }
    minuteFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const value = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value);
  return value("hour") * 60 + value("minute");
}

export function dozoInQuietHours(hours: DozoQuietHours, at: Date, timeZone: string): boolean {
  const minute = localMinute(at, timeZone);
  return hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute
    : minute >= hours.startMinute || minute < hours.endMinute;
}

/**
 * The first whole minute after `at` that is outside quiet hours. Walking minutes keeps clock
 * changes right: an end that a spring-forward skips becomes the first minute after the gap.
 */
export function dozoQuietHoursEnd(hours: DozoQuietHours, at: Date, timeZone: string): Date {
  const first = Math.floor(at.getTime() / 60_000) * 60_000 + 60_000;
  // A day and two hours covers the longest range plus a clock change.
  for (let step = 0; step < DAY_MINUTES + 120; step += 1) {
    const candidate = new Date(first + step * 60_000);
    if (!dozoInQuietHours(hours, candidate, timeZone)) return candidate;
  }
  return new Date(first + DAY_MINUTES * 60_000);
}

export async function readDozoQuietHours(
  prisma: PrismaClient,
  userId: string,
): Promise<DozoQuietHours | null> {
  const rows = await prisma.$queryRaw<DozoQuietHours[]>`
    SELECT "startMinute", "endMinute" FROM dozo_quiet_hours WHERE "userId" = ${userId}`;
  return rows[0] ?? null;
}

interface SaveDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
}

/**
 * Sets or clears the account's quiet hours. Routines held for the old hours go back to when they
 * were due and wake now, so the new hours decide again whether they run or wait.
 */
export async function saveDozoQuietHours(
  deps: SaveDeps,
  userId: string,
  hours: DozoQuietHours | null,
): Promise<void> {
  const released = await runAsSystem("set an account's quiet hours and release its routines", () =>
    deps.prisma.$transaction(async (tx) => {
      if (hours) {
        await tx.$executeRaw`
          INSERT INTO dozo_quiet_hours ("userId", "startMinute", "endMinute")
          VALUES (${userId}, ${hours.startMinute}, ${hours.endMinute})
          ON CONFLICT ("userId") DO UPDATE SET "startMinute" = EXCLUDED."startMinute",
            "endMinute" = EXCLUDED."endMinute", "updatedAt" = CURRENT_TIMESTAMP`;
      } else {
        await tx.$executeRaw`DELETE FROM dozo_quiet_hours WHERE "userId" = ${userId}`;
      }
      const held = await tx.$queryRaw<
        Array<{ routineId: string; spaceId: string; dueAt: Date; heldUntil: Date }>
      >`
        SELECT h."routineId", r."spaceId", h."dueAt", h."heldUntil"
        FROM dozo_routine_holds h JOIN routines r ON r.id = h."routineId"
        WHERE r."userId" = ${userId} AND r.active AND h."heldUntil" > CURRENT_TIMESTAMP`;
      const woken: typeof held = [];
      for (const hold of held) {
        // Only a routine still waiting on this hold moves; an edit since then already rescheduled it.
        const { count } = await tx.routine.updateMany({
          where: { id: hold.routineId, active: true, nextRunAt: hold.heldUntil },
          data: { nextRunAt: hold.dueAt },
        });
        if (count === 1) woken.push(hold);
      }
      return woken;
    }),
  );
  for (const spaceId of new Set(released.map((hold) => hold.spaceId)))
    await bestEffort("quiet hours routine change", deps.events?.publishSpaceChange?.(spaceId, "routines"));
  // After the commit, like every routine write; a failed enqueue is repaired by the reconciler.
  for (const hold of released)
    await bestEffort(
      "quiet hours routine wakeup",
      deps.jobs.enqueue(routineWakeupJob(hold.routineId, hold.dueAt)),
    );
}

interface WakeDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "publishSpaceChange">;
}

interface WakingRoutine {
  id: string;
  spaceId: string;
  userId: string;
  crons: string[];
  timezone: string;
  watch: unknown;
}

/**
 * Called when a routine's due wake fires, before it runs. Returns true when this wake is taken
 * care of here and the routine must not run now:
 * - a wake that ends a quiet-hours hold puts the routine back on the occurrence it held and
 *   wakes that, so the run keeps its due time (and shows as late) and its schedule its phase;
 * - a scheduled run missed by more than {@link DOZO_ROUTINE_CATCH_UP_MS}, with no occurrence
 *   inside that window either, is skipped: a recurring routine moves to its next occurrence, a
 *   one-time one ends;
 * - during the owner's quiet hours the routine waits for their end. Hourly ticks inside them
 *   become one run, and a change check looks once.
 */
export async function dozoHoldRoutine<Deps extends WakeDeps>(
  deps: Deps,
  routine: WakingRoutine,
  scheduledAt: Date,
  wake: (deps: Deps, routineId: string, scheduledFor: string) => Promise<void>,
): Promise<boolean> {
  const [state] = await deps.prisma.$queryRaw<
    Array<{
      dueAt: Date | null;
      heldUntil: Date | null;
      startMinute: number | null;
      endMinute: number | null;
      timezone: string | null;
    }>
  >`
    SELECT h."dueAt", h."heldUntil", q."startMinute", q."endMinute", u.timezone
    FROM "user" u
    LEFT JOIN dozo_quiet_hours q ON q."userId" = u.id
    LEFT JOIN dozo_routine_holds h ON h."routineId" = ${routine.id}
    WHERE u.id = ${routine.userId}`;
  const now = new Date();
  const changed = (spaceId: string) =>
    bestEffort("routine hold change", deps.events.publishSpaceChange?.(spaceId, "routines"));

  if (state?.dueAt && state.heldUntil?.getTime() === scheduledAt.getTime()) {
    const restored = await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: state.dueAt },
    });
    if (restored.count === 1) await wake(deps, routine.id, state.dueAt.toISOString());
    return true;
  }

  if (routine.watch == null) {
    // A held run counts as due when its hold ended: the owner chose that wait.
    const heldUntil =
      state?.dueAt?.getTime() === scheduledAt.getTime() ? (state.heldUntil?.getTime() ?? 0) : 0;
    const dueFrom = Math.max(scheduledAt.getTime(), heldUntil);
    const windowStart = new Date(now.getTime() - DOZO_ROUTINE_CATCH_UP_MS);
    const recent =
      now.getTime() - dueFrom <= DOZO_ROUTINE_CATCH_UP_MS ||
      (nextRoutineRunDateAcross(routine.crons, scheduledAt, windowStart, routine.timezone)
        ?.getTime() ?? Number.POSITIVE_INFINITY) <= now.getTime();
    if (!recent) {
      const nextRunAt = isOneShotRoutineCrons(routine.crons)
        ? null
        : nextRoutineRunDateAcross(routine.crons, scheduledAt, now, routine.timezone);
      const skipped = await deps.prisma.routine.updateMany({
        where: { id: routine.id, active: true, nextRunAt: scheduledAt },
        data: { nextRunAt, ...(nextRunAt ? {} : { active: false }) },
      });
      if (skipped.count !== 1) return true;
      getLogger().info("routine.missed", {
        "routine.id": routine.id,
        "routine.due_at": scheduledAt.toISOString(),
      });
      await changed(routine.spaceId);
      if (nextRunAt) await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
      return true;
    }
  }

  if (state?.startMinute == null || state.endMinute == null) return false;
  const hours = { startMinute: state.startMinute, endMinute: state.endMinute };
  const zone = state.timezone ?? routine.timezone;
  if (!dozoInQuietHours(hours, now, zone)) return false;
  const heldUntil = dozoQuietHoursEnd(hours, now, zone);
  const held = await deps.prisma.$transaction(async (tx) => {
    const moved = await tx.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: heldUntil },
    });
    if (moved.count !== 1) return false;
    await tx.$executeRaw`
      INSERT INTO dozo_routine_holds ("routineId", "dueAt", "heldUntil")
      VALUES (${routine.id}, ${scheduledAt}, ${heldUntil})
      ON CONFLICT ("routineId") DO UPDATE SET "dueAt" = EXCLUDED."dueAt",
        "heldUntil" = EXCLUDED."heldUntil"`;
    return true;
  });
  if (held) {
    await changed(routine.spaceId);
    await deps.jobs.enqueue(routineWakeupJob(routine.id, heldUntil));
  }
  return true;
}
