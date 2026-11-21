import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { DozoQuietHours, DozoQuietRange } from "@rakazo/contracts";
import { DOZO_QUIET_DAYS, dozoQuietDayBit, dozoQuietHoursOf } from "@rakazo/contracts";
import { ClientError, isOneShotRoutineCrons, nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

// The suggestion reaches the API through this module, which the adapters index already exports.
export * from "./dozo-quiet-hours-suggest.js";

/** A missed scheduled run still starts when it is at most this late, once; older ones are skipped. */
export const DOZO_ROUTINE_CATCH_UP_MS = 12 * 60 * 60_000;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
/** How far an end is looked for: a week of touching ranges plus a day, and a clock change. */
const END_SEARCH_MINUTES = 8 * DAY_MINUTES + 120;
/** Zones change their offset on a quarter hour, so one lookup holds for the quarter hour it is in. */
const OFFSET_STEP_MS = 15 * MINUTE_MS;

const offsetFormats = new Map<string, Intl.DateTimeFormat | null>();

/** The zone's wall clock minus UTC at `at`, in milliseconds; an unknown zone counts as UTC. */
function zoneOffset(at: number, timeZone: string): number {
  let format = offsetFormats.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      format = null;
    }
    offsetFormats.set(timeZone, format);
  }
  if (!format) return 0;
  const parts = format.formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
  );
  return wall - Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

/**
 * Local weekday (Monday 0) and minute past midnight of instants in one zone, asking the zone once
 * per quarter hour instead of once per instant.
 */
function localClock(timeZone: string) {
  let step = Number.NaN;
  let offset = 0;
  return (at: number) => {
    const current = Math.floor(at / OFFSET_STEP_MS);
    if (current !== step) {
      step = current;
      offset = zoneOffset(current * OFFSET_STEP_MS, timeZone);
    }
    const wall = new Date(at + offset);
    return {
      weekday: (wall.getUTCDay() + 6) % 7,
      minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    };
  };
}

function covered(
  ranges: readonly DozoQuietRange[],
  { weekday, minute }: { weekday: number; minute: number },
): boolean {
  const on = (days: number, day: number) => (days & dozoQuietDayBit(day)) !== 0;
  return ranges.some((range) =>
    range.startMinute < range.endMinute
      ? on(range.days, weekday) && minute >= range.startMinute && minute < range.endMinute
      : // Across midnight: the morning part belongs to the day before.
        (on(range.days, weekday) && minute >= range.startMinute) ||
        (on(range.days, (weekday + 6) % 7) && minute < range.endMinute),
  );
}

/** Whether the ranges together leave no minute of the week outside them, on any day. */
export function dozoQuietHoursCoverWeek(ranges: readonly DozoQuietRange[]): boolean {
  for (let minute = 0; minute < WEEK_MINUTES; minute += 1) {
    const weekday = Math.floor(minute / DAY_MINUTES);
    if (!covered(ranges, { weekday, minute: minute % DAY_MINUTES })) return false;
  }
  return true;
}

/** What a save sets: every range, or new times for the first range only. */
export type DozoQuietHoursChange = readonly DozoQuietRange[] | { hours: DozoQuietHours };

/** The first range with these times, its days and the other ranges kept; one on every day for none. */
function withFirstHours(
  ranges: readonly DozoQuietRange[],
  hours: DozoQuietHours,
): DozoQuietRange[] {
  const [first, ...rest] = ranges;
  return [
    {
      startMinute: hours.startMinute,
      endMinute: hours.endMinute,
      days: first?.days ?? DOZO_QUIET_DAYS.ALL,
    },
    ...rest,
  ];
}

/**
 * The ranges a change leaves the account with. Refused when they would leave no time at all
 * outside them: routines would never start.
 */
export function dozoQuietRangesAfter(
  current: readonly DozoQuietRange[],
  change: DozoQuietHoursChange,
): DozoQuietRange[] {
  const next = "hours" in change ? withFirstHours(current, change.hours) : [...change];
  if (dozoQuietHoursCoverWeek(next))
    throw new ClientError("BAD_REQUEST", "Quiet hours need some time outside them");
  return next;
}

/** Whether `at` falls in any of the ranges, read on the local day and clock of `timeZone`. */
export function dozoInQuietHours(
  ranges: readonly DozoQuietRange[],
  at: Date,
  timeZone: string,
): boolean {
  return covered(ranges, localClock(timeZone)(at.getTime()));
}

/**
 * The first whole minute after `at` that is outside every range. Walking minutes keeps clock
 * changes right: an end that a spring-forward skips becomes the first minute after the gap.
 */
export function dozoQuietHoursEnd(
  ranges: readonly DozoQuietRange[],
  at: Date,
  timeZone: string,
): Date {
  const clock = localClock(timeZone);
  const first = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < END_SEARCH_MINUTES; step += 1) {
    const candidate = first + step * MINUTE_MS;
    if (!covered(ranges, clock(candidate))) return new Date(candidate);
  }
  // Ranges that cover every minute: wait a day, as a single range that never ended did.
  return new Date(first + DAY_MINUTES * MINUTE_MS);
}

/** Both quiet-hours tables as one row selects them; array_agg gives null for no ranges. */
interface QuietColumns {
  startMinute: number | null;
  endMinute: number | null;
  rangeStarts?: number[] | null;
  rangeEnds?: number[] | null;
  rangeDays?: number[] | null;
}

/**
 * The account's ranges. Every save writes the previous release's single range as the first
 * range's times, in the same transaction, so while a deploy (or a rollback) runs that release
 * the two tables tell what it did since: its range gone means it turned quiet hours off, and
 * other times mean it changed them, which go on the first range as a save of `hours` does. With
 * no rows of the fork's own, its single range is one on every day.
 */
function quietRanges(row: QuietColumns | undefined): DozoQuietRange[] {
  const legacy =
    row?.startMinute != null && row.endMinute != null
      ? { startMinute: row.startMinute, endMinute: row.endMinute }
      : null;
  if (!row?.rangeStarts?.length) return legacy ? withFirstHours([], legacy) : [];
  if (!legacy) return [];
  // The three arrays come from the same rows in the same order.
  const ends = row.rangeEnds as number[];
  const days = row.rangeDays as number[];
  const ranges = row.rangeStarts.map((startMinute, index) => ({
    startMinute,
    endMinute: ends[index] as number,
    days: days[index] as number,
  }));
  return withFirstHours(ranges, legacy);
}

/** Both quiet-hours tables of one account, as one row. */
function selectQuiet(db: Pick<PrismaClient, "$queryRaw">, userId: string) {
  return db.$queryRaw<QuietColumns[]>`
    SELECT q."startMinute", q."endMinute", r."rangeStarts", r."rangeEnds", r."rangeDays"
    FROM (SELECT ${userId}::text AS id) u
    LEFT JOIN dozo_quiet_hours q ON q."userId" = u.id
    LEFT JOIN LATERAL (
      SELECT array_agg("startMinute" ORDER BY position) AS "rangeStarts",
        array_agg("endMinute" ORDER BY position) AS "rangeEnds",
        array_agg(days::int ORDER BY position) AS "rangeDays"
      FROM dozo_quiet_hour_ranges WHERE "userId" = u.id) r ON true`;
}

/** The account's quiet hours, in the order they were saved; an empty list when they are off. */
export async function readDozoQuietHours(
  prisma: PrismaClient,
  userId: string,
): Promise<DozoQuietRange[]> {
  return quietRanges((await selectQuiet(prisma, userId))[0]);
}

interface SaveDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
}

/**
 * Changes the account's quiet hours (see {@link dozoQuietRangesAfter}), or clears them with no
 * ranges, and returns what they are now. Routines held for the old hours go back to when they were
 * due and wake now, so the new hours decide again whether they run or wait.
 */
export async function saveDozoQuietHours(
  deps: SaveDeps,
  userId: string,
  change: DozoQuietHoursChange,
): Promise<DozoQuietRange[]> {
  const { ranges, released } = await runAsSystem(
    "set an account's quiet hours and release its routines",
    () =>
      deps.prisma.$transaction(async (tx) => {
        // One save at a time per account, so two at once cannot both write position 0, and new
        // times for the first range land on the ranges as they are.
        await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`dozo-quiet-hours:${userId}`}, 0))::text AS "lock"`;
        const current = "hours" in change ? quietRanges((await selectQuiet(tx, userId))[0]) : [];
        const ranges = dozoQuietRangesAfter(current, change);
        await tx.$executeRaw`DELETE FROM dozo_quiet_hour_ranges WHERE "userId" = ${userId}`;
        if (ranges.length)
          await tx.$executeRaw`
          INSERT INTO dozo_quiet_hour_ranges ("userId", position, "startMinute", "endMinute", days)
          SELECT ${userId}, r.position - 1, r."startMinute", r."endMinute", r.days
          FROM unnest(${ranges.map((range) => range.startMinute)}::int[],
            ${ranges.map((range) => range.endMinute)}::int[],
            ${ranges.map((range) => range.days)}::int[])
            WITH ORDINALITY AS r("startMinute", "endMinute", days, position)`;
        // The previous release reads only this table while a deploy runs: it gets the first range,
        // on every day, which is close enough for those few minutes. Always written with the first
        // range's times, it also tells a later read what that release changed (quietRanges).
        const hours = dozoQuietHoursOf(ranges);
        if (hours) {
          await tx.$executeRaw`
          INSERT INTO dozo_quiet_hours ("userId", "startMinute", "endMinute")
          VALUES (${userId}, ${hours.startMinute}, ${hours.endMinute})
          ON CONFLICT ("userId") DO UPDATE SET "startMinute" = EXCLUDED."startMinute",
            "endMinute" = EXCLUDED."endMinute", "updatedAt" = CURRENT_TIMESTAMP`;
        } else {
          await tx.$executeRaw`DELETE FROM dozo_quiet_hours WHERE "userId" = ${userId}`;
        }
        // Times as UTC wall clocks: the client reads a timestamptz in the session's zone as if it
        // were UTC, so a database in another zone would shift them (dozo/AGENTS.md).
        const held = await tx.$queryRaw<
          Array<{ routineId: string; spaceId: string; dueAt: Date; heldUntil: Date }>
        >`
        SELECT h."routineId", r."spaceId", h."dueAt" AT TIME ZONE 'UTC' AS "dueAt",
          h."heldUntil" AT TIME ZONE 'UTC' AS "heldUntil"
        FROM dozo_routine_holds h JOIN routines r ON r.id = h."routineId"
        WHERE r."userId" = ${userId} AND r.active AND h."heldUntil" > CURRENT_TIMESTAMP
          AND h.crons = r.crons AND h.timezone = r.timezone`;
        const woken: typeof held = [];
        for (const hold of held) {
          // Only a routine still waiting on this hold moves; an edit since then already rescheduled it.
          const { count } = await tx.routine.updateMany({
            where: { id: hold.routineId, active: true, nextRunAt: hold.heldUntil },
            data: { nextRunAt: hold.dueAt },
          });
          if (count === 1) woken.push(hold);
        }
        return { ranges, released: woken };
      }),
  );
  for (const spaceId of new Set(released.map((hold) => hold.spaceId)))
    await bestEffort(
      "quiet hours routine change",
      deps.events?.publishSpaceChange?.(spaceId, "routines"),
    );
  // After the commit, like every routine write; a failed enqueue is repaired by the reconciler.
  for (const hold of released)
    await bestEffort(
      "quiet hours routine wakeup",
      deps.jobs.enqueue(routineWakeupJob(hold.routineId, hold.dueAt)),
    );
  return ranges;
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
 * A hold counts only while the routine keeps the schedule it was held under.
 */
export async function dozoHoldRoutine<Deps extends WakeDeps>(
  deps: Deps,
  routine: WakingRoutine,
  scheduledAt: Date,
  wake: (deps: Deps, routineId: string, scheduledFor: string) => Promise<void>,
): Promise<boolean> {
  // Optional, like a run's lateness: a failed read leaves the routine to run as it always did.
  const rows = await bestEffort(
    "routine quiet hours",
    (async () =>
      deps.prisma.$queryRaw<
        Array<
          QuietColumns & { dueAt: Date | null; heldUntil: Date | null; timezone: string | null }
        >
      >`
    SELECT h."dueAt" AT TIME ZONE 'UTC' AS "dueAt", h."heldUntil" AT TIME ZONE 'UTC' AS "heldUntil",
      q."startMinute", q."endMinute", r."rangeStarts", r."rangeEnds", r."rangeDays", u.timezone
    FROM "user" u
    LEFT JOIN dozo_quiet_hours q ON q."userId" = u.id
    LEFT JOIN LATERAL (
      SELECT array_agg("startMinute" ORDER BY position) AS "rangeStarts",
        array_agg("endMinute" ORDER BY position) AS "rangeEnds",
        array_agg(days::int ORDER BY position) AS "rangeDays"
      FROM dozo_quiet_hour_ranges WHERE "userId" = u.id) r ON true
    LEFT JOIN dozo_routine_holds h ON h."routineId" = ${routine.id}
      AND h.crons = ${routine.crons}::text[] AND h.timezone = ${routine.timezone}
    WHERE u.id = ${routine.userId}`)(),
  );
  if (!rows) return false;
  const [state] = rows;
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
      (nextRoutineRunDateAcross(
        routine.crons,
        scheduledAt,
        windowStart,
        routine.timezone,
      )?.getTime() ?? Number.POSITIVE_INFINITY) <= now.getTime();
    if (!recent) {
      const oneShot = isOneShotRoutineCrons(routine.crons);
      const nextRunAt = oneShot
        ? null
        : nextRoutineRunDateAcross(routine.crons, scheduledAt, now, routine.timezone);
      // A repeat with no schedule that parses runs once and then pauses, as it always has.
      if (!oneShot && !nextRunAt) return false;
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

  const ranges = quietRanges(state);
  if (!ranges.length) return false;
  const zone = state?.timezone ?? routine.timezone;
  if (!dozoInQuietHours(ranges, now, zone)) return false;
  const heldUntil = dozoQuietHoursEnd(ranges, now, zone);
  const held = await deps.prisma.$transaction(async (tx) => {
    const moved = await tx.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: heldUntil },
    });
    if (moved.count !== 1) return false;
    await tx.$executeRaw`
      INSERT INTO dozo_routine_holds ("routineId", "dueAt", "heldUntil", crons, timezone)
      VALUES (${routine.id}, ${scheduledAt.toISOString()}::timestamptz,
        ${heldUntil.toISOString()}::timestamptz, ${routine.crons}::text[], ${routine.timezone})
      ON CONFLICT ("routineId") DO UPDATE SET "dueAt" = EXCLUDED."dueAt",
        "heldUntil" = EXCLUDED."heldUntil", crons = EXCLUDED.crons, timezone = EXCLUDED.timezone`;
    return true;
  });
  if (held) {
    await changed(routine.spaceId);
    await deps.jobs.enqueue(routineWakeupJob(routine.id, heldUntil));
  }
  return true;
}
