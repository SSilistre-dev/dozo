/**
 * The one check of what a write may put on the user's phone, as the wire carries it: the server
 * runs it before any approval card (packages/adapters/src/dozo-phone-input.ts) and the phone again
 * before it writes (apps/mobile/lib/dozo-phone-*-write.ts), so both accept and refuse the same
 * items. It checks and never changes: whatever makes text one line happens before it.
 */

export const PHONE_WRITE_LIMITS = {
  title: 200,
  location: 200,
  notes: 1000,
  list: 100,
  /** The longest event. */
  eventDays: 31,
  /** How far back and ahead of now an event may start. */
  startDaysBefore: 1,
  startDaysAhead: 730,
  interval: 30,
  count: 365,
} as const;

export const PHONE_RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

export interface PhoneRecurrence {
  frequency: (typeof PHONE_RECURRENCE_FREQUENCIES)[number];
  interval: number;
  count?: number;
  until?: string;
}

/**
 * One event. A timed one starts and ends at ISO 8601 times with an offset; an all-day one on dates
 * (`YYYY-MM-DD`, end exclusive), which the phone places on those dates in its own time zone.
 */
export interface PhoneEventWrite {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  recurrence?: PhoneRecurrence;
}

export interface PhoneReminderWrite {
  title: string;
  due?: string;
  notes?: string;
  list?: string;
}

export type PhoneWriteCheck<T> = { value: T } | { error: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_EXAMPLE = "ISO 8601 times with an offset, such as 2026-03-02T09:00:00+01:00";

/** The time given, when it is ISO 8601 with an offset. */
export function isoWithOffset(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) return undefined;
  const hour = Number(value.slice(11, 13));
  return dateOnly(value.slice(0, 10)) && hour <= 23 && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/** The date given, when it is a real `YYYY-MM-DD` day. */
export function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value) ? value : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first key that is not one of `known`. */
const unknownKey = (value: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(value).find((key) => !known.includes(key));

/** Optional text of at most `max`; required text has at least one character. */
function text(
  value: Record<string, unknown>,
  key: string,
  max: number,
  required = false,
): PhoneWriteCheck<string | undefined> {
  const given = value[key];
  if (given === undefined && !required) return { value: undefined };
  if (typeof given !== "string")
    return { error: required ? `${key} is required.` : `${key} must be text.` };
  if (required && !given) return { error: `${key} is required.` };
  if (given.length > max) return { error: `${key} can be at most ${max} characters.` };
  return { value: given || undefined };
}

const whole = (value: unknown, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

const EVENT_KEYS = ["title", "start", "end", "allDay", "location", "notes", "recurrence"];
const RECURRENCE_KEYS = ["frequency", "interval", "count", "until"];
const REMINDER_KEYS = ["title", "due", "notes", "list"];

/** An event as a write may create it, or why it may not: any field besides EVENT_KEYS included. */
export function checkPhoneEvent(value: unknown, now: number): PhoneWriteCheck<PhoneEventWrite> {
  if (!isRecord(value)) return { error: "The event must be an object." };
  const extra = unknownKey(value, EVENT_KEYS);
  if (extra !== undefined) return { error: `"${extra}" is not accepted.` };
  const title = text(value, "title", PHONE_WRITE_LIMITS.title, true);
  if ("error" in title) return title;
  const { allDay } = value;
  if (typeof allDay !== "boolean") return { error: "allDay must be true or false." };
  const read = allDay ? dateOnly : isoWithOffset;
  const start = read(value.start);
  const end = read(value.end);
  if (!start || !end)
    return {
      error: allDay
        ? "start and end of an all-day event must be dates, such as 2026-03-01, end being the day after the last day."
        : `start and end must be ${TIME_EXAMPLE}.`,
    };
  const from = Date.parse(start);
  const span = Date.parse(end) - from;
  if (span <= 0) return { error: "end must be after start." };
  if (span > PHONE_WRITE_LIMITS.eventDays * DAY_MS)
    return { error: `An event can last at most ${PHONE_WRITE_LIMITS.eventDays} days.` };
  // A date is read at midnight UTC; the day it names begins up to a day earlier or later somewhere.
  const zone = allDay ? DAY_MS : 0;
  const earliest = now - PHONE_WRITE_LIMITS.startDaysBefore * DAY_MS - zone;
  const latest = now + PHONE_WRITE_LIMITS.startDaysAhead * DAY_MS + zone;
  if (from < earliest || from > latest)
    return { error: "start must be within a day before now and two years after it." };
  const location = text(value, "location", PHONE_WRITE_LIMITS.location);
  if ("error" in location) return location;
  const notes = text(value, "notes", PHONE_WRITE_LIMITS.notes);
  if ("error" in notes) return notes;
  const recurrence =
    value.recurrence === undefined ? undefined : checkRecurrence(value.recurrence, start, read);
  if (recurrence && "error" in recurrence) return recurrence;
  return {
    value: {
      title: title.value as string,
      start,
      end,
      allDay,
      ...(location.value ? { location: location.value } : {}),
      ...(notes.value ? { notes: notes.value } : {}),
      ...(recurrence ? { recurrence: recurrence.value } : {}),
    },
  };
}

/** When the `count`th time falls: months and years are calendar ones, so a leap year counts. */
function lastOccurrence(
  start: string,
  frequency: PhoneRecurrence["frequency"],
  interval: number,
  count: number,
): number {
  const steps = (count - 1) * interval;
  const first = new Date(Date.parse(start));
  if (frequency === "daily" || frequency === "weekly")
    return first.getTime() + steps * (frequency === "daily" ? 1 : 7) * DAY_MS;
  first.setUTCMonth(first.getUTCMonth() + steps * (frequency === "monthly" ? 1 : 12));
  return first.getTime();
}

/** How an event repeats: it always ends, after `count` times or on `until` (as start is written). */
function checkRecurrence(
  value: unknown,
  start: string,
  read: (value: unknown) => string | undefined,
): PhoneWriteCheck<PhoneRecurrence> {
  if (!isRecord(value))
    return { error: "recurrence must be an object with frequency and count or until." };
  const extra = unknownKey(value, RECURRENCE_KEYS);
  if (extra !== undefined) return { error: `"${extra}" is not accepted in recurrence.` };
  const frequency = PHONE_RECURRENCE_FREQUENCIES.find((entry) => entry === value.frequency);
  if (!frequency)
    return { error: "recurrence frequency must be daily, weekly, monthly or yearly." };
  const { interval, count } = value;
  if (!whole(interval, PHONE_WRITE_LIMITS.interval))
    return {
      error: `recurrence interval must be a whole number from 1 to ${PHONE_WRITE_LIMITS.interval}.`,
    };
  if (count !== undefined && !whole(count, PHONE_WRITE_LIMITS.count))
    return {
      error: `recurrence count must be a whole number from 1 to ${PHONE_WRITE_LIMITS.count}.`,
    };
  const until = value.until === undefined ? undefined : read(value.until);
  if (value.until !== undefined && (!until || Date.parse(until) < Date.parse(start)))
    return { error: "recurrence until must be written as start is, and not before it." };
  if (until && Date.parse(until) - Date.parse(start) > PHONE_WRITE_LIMITS.startDaysAhead * DAY_MS)
    return { error: "recurrence until can be at most two years after start." };
  if (
    count !== undefined &&
    lastOccurrence(start, frequency, interval as number, count as number) - Date.parse(start) >
      PHONE_WRITE_LIMITS.startDaysAhead * DAY_MS
  )
    return { error: "recurrence can last at most two years after start." };
  if ((count === undefined) === (until === undefined))
    return { error: "recurrence needs count or until, not both, so that it ends." };
  return {
    value: {
      frequency,
      interval: interval as number,
      ...(count !== undefined ? { count: count as number } : {}),
      ...(until ? { until } : {}),
    },
  };
}

/** A reminder as a write may create it, or why it may not. */
export function checkPhoneReminder(value: unknown): PhoneWriteCheck<PhoneReminderWrite> {
  if (!isRecord(value)) return { error: "The reminder must be an object." };
  const extra = unknownKey(value, REMINDER_KEYS);
  if (extra !== undefined) return { error: `"${extra}" is not accepted.` };
  const title = text(value, "title", PHONE_WRITE_LIMITS.title, true);
  if ("error" in title) return title;
  const due = value.due === undefined ? undefined : isoWithOffset(value.due);
  if (value.due !== undefined && !due) return { error: `due must be ${TIME_EXAMPLE}.` };
  const notes = text(value, "notes", PHONE_WRITE_LIMITS.notes);
  if ("error" in notes) return notes;
  const list = text(value, "list", PHONE_WRITE_LIMITS.list);
  if ("error" in list) return list;
  return {
    value: {
      title: title.value as string,
      ...(due ? { due } : {}),
      ...(notes.value ? { notes: notes.value } : {}),
      ...(list.value ? { list: list.value } : {}),
    },
  };
}
