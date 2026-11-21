import type { DozoQuietRange } from "@rakazo/contracts";
import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/** How far back a suggestion looks at what the account wrote. */
export const DOZO_QUIET_SUGGEST_DAYS = 28;
/** Fewer messages than this, or fewer days with one, is too little to suggest from. */
const MIN_MESSAGES = 20;
const MIN_ACTIVE_DAYS = 7;
/** Weekdays or the weekend need this many days with a message to be read on their own. */
const MIN_GROUP_ACTIVE_DAYS = 3;
/** Without an hour written in on this share of a group's days, nothing stands out: no suggestion. */
const MIN_PEAK_SHARE = 0.3;
/** An hour is quiet when it is written in on at most this part of the busiest hour's share. */
const QUIET_SHARE_OF_PEAK = 0.2;
const MIN_QUIET_HOURS = 3;
const MAX_QUIET_HOURS = 12;
/** Weekday and weekend ranges whose starts and ends are this close become one range on every day. */
const JOIN_WITHIN_MINUTES = 60;

const HOURS = 24;
const DAY_MINUTES = HOURS * 60;

/** Messages the account wrote in one local hour of one local day; weekday Monday 0 to Sunday 6. */
export interface DozoHourActivity {
  day: string;
  weekday: number;
  hour: number;
  messages: number;
}

interface Stretch {
  start: number;
  length: number;
}

/** The longest run of quiet hours around the clock, the least written-in one of equal runs. */
function longestQuiet(quiet: readonly boolean[], share: readonly number[]): Stretch | null {
  // Start counting after a busy hour, so a run across midnight is counted whole.
  const busy = quiet.indexOf(false);
  let best: (Stretch & { load: number }) | null = null;
  let run: (Stretch & { load: number }) | null = null;
  for (let step = 1; step <= HOURS; step += 1) {
    const hour = (busy + step) % HOURS;
    if (!quiet[hour]) {
      if (
        run &&
        (!best || run.length > best.length || (run.length === best.length && run.load < best.load))
      )
        best = run;
      run = null;
      continue;
    }
    run = run ?? { start: hour, length: 0, load: 0 };
    run.length += 1;
    run.load += share[hour] as number;
  }
  return best;
}

/** The longest stretch shortened to the most a suggestion covers: the quietest part, the latest of equals. */
function trimmed(stretch: Stretch, share: readonly number[]): Stretch {
  if (stretch.length <= MAX_QUIET_HOURS) return stretch;
  let best = { start: stretch.start, load: Number.POSITIVE_INFINITY };
  for (let offset = 0; offset + MAX_QUIET_HOURS <= stretch.length; offset += 1) {
    let load = 0;
    for (let hour = 0; hour < MAX_QUIET_HOURS; hour += 1)
      load += share[(stretch.start + offset + hour) % HOURS] as number;
    if (load <= best.load) best = { start: (stretch.start + offset) % HOURS, load };
  }
  return { start: best.start, length: MAX_QUIET_HOURS };
}

/** The quiet range of one group of days (weekdays or the weekend), or null when none is clear. */
function groupRange(
  activity: readonly DozoHourActivity[],
): Pick<DozoQuietRange, "startMinute" | "endMinute"> | null {
  const days = new Set(activity.map((entry) => entry.day));
  if (days.size < MIN_GROUP_ACTIVE_DAYS) return null;
  // The share of days written in at each hour: a long evening counts like a single message.
  const daysAt = Array.from({ length: HOURS }, () => new Set<string>());
  for (const entry of activity) daysAt[entry.hour]?.add(entry.day);
  const share = daysAt.map((written) => written.size / days.size);
  const peak = Math.max(...share);
  if (peak < MIN_PEAK_SHARE) return null;
  const stretch = longestQuiet(
    share.map((value) => value <= peak * QUIET_SHARE_OF_PEAK),
    share,
  );
  if (!stretch || stretch.length < MIN_QUIET_HOURS) return null;
  const { start, length } = trimmed(stretch, share);
  return { startMinute: start * 60, endMinute: ((start + length) % HOURS) * 60 };
}

/** How far `to` is from `from` around the clock, from minus half a day to plus half a day. */
function around(from: number, to: number): number {
  return ((to - from + DAY_MINUTES + DAY_MINUTES / 2) % DAY_MINUTES) - DAY_MINUTES / 2;
}

/** Between two minutes of the day, the short way round: on the half hour for whole hours. */
function between(a: number, b: number): number {
  return (a + around(a, b) / 2 + DAY_MINUTES) % DAY_MINUTES;
}

/**
 * Quiet hours fitted to when someone writes: per weekdays and weekend, the longest stretch of
 * hours they seldom write in (3 to 12 hours), joined into one range on every day when the two are
 * within an hour of each other. Null when there is too little to go on or no clear stretch.
 */
export function dozoSuggestQuietHours(
  activity: readonly DozoHourActivity[],
): DozoQuietRange[] | null {
  const messages = activity.reduce((sum, entry) => sum + entry.messages, 0);
  const days = new Set(activity.map((entry) => entry.day));
  if (messages < MIN_MESSAGES || days.size < MIN_ACTIVE_DAYS) return null;
  const weekend = (entry: DozoHourActivity) => entry.weekday >= 5;
  const weekdays = groupRange(activity.filter((entry) => !weekend(entry)));
  const weekends = groupRange(activity.filter(weekend));
  if (weekdays && weekends) {
    const close = (a: number, b: number) => Math.abs(around(a, b)) <= JOIN_WITHIN_MINUTES;
    if (
      close(weekdays.startMinute, weekends.startMinute) &&
      close(weekdays.endMinute, weekends.endMinute)
    )
      return [
        {
          startMinute: between(weekdays.startMinute, weekends.startMinute),
          endMinute: between(weekdays.endMinute, weekends.endMinute),
          days: DOZO_QUIET_DAYS.ALL,
        },
      ];
  }
  const ranges = [
    ...(weekdays ? [{ ...weekdays, days: DOZO_QUIET_DAYS.WEEKDAYS }] : []),
    ...(weekends ? [{ ...weekends, days: DOZO_QUIET_DAYS.WEEKEND }] : []),
  ];
  return ranges.length ? ranges : null;
}

/**
 * Suggests quiet hours from the times of the account's own messages of the last four weeks, in its
 * timezone (UTC when unset or unknown). Only counts per local hour leave the database, nothing is
 * kept, and only the ranges reach the caller.
 */
export async function suggestDozoQuietHours(
  prisma: PrismaClient,
  userId: string,
): Promise<DozoQuietRange[] | null> {
  // The account's messages may be in any Space it is in, so the read is not held to one; the
  // author filter keeps it to the account's own. "createdAt" is a UTC wall clock (timestamp
  // without zone): it becomes an instant, then the account's local time, in any session zone.
  const activity = await runAsSystem(
    "suggest quiet hours from the account's own messages",
    () =>
      prisma.$queryRaw<DozoHourActivity[]>`
      WITH zone AS (
        SELECT COALESCE(
          (SELECT n.name FROM "user" u JOIN pg_timezone_names n ON n.name = u.timezone
           WHERE u.id = ${userId} LIMIT 1), 'UTC') AS name
      ), written AS (
        SELECT (m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE zone.name AS at
        FROM messages m CROSS JOIN zone
        WHERE m."authorUserId" = ${userId} AND m.role = 'user'
          AND m."createdAt" >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            - make_interval(days => ${DOZO_QUIET_SUGGEST_DAYS}::int)
      )
      SELECT to_char(at, 'YYYY-MM-DD') AS day, EXTRACT(ISODOW FROM at)::int - 1 AS weekday,
        EXTRACT(HOUR FROM at)::int AS hour, count(*)::int AS messages
      FROM written GROUP BY 1, 2, 3`,
  );
  return dozoSuggestQuietHours(activity);
}
