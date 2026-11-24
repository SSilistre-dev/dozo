import type { PhoneEventWrite } from "@rakazo/contracts";
import { checkPhoneEvent } from "@rakazo/contracts";
import { Platform } from "react-native";
import type { PhonePermission } from "./dozo-phone-calendar";
import {
  calendarAvailable,
  calendarPermission,
  PhoneReadError,
  requestCalendarPermission,
  text,
} from "./dozo-phone-calendar";
import { writePermission } from "./dozo-phone-write-permission";

/**
 * Adds one event the user approved to the phone's default calendar (wire contract:
 * `phoneCalendarCreate`). Create only: nothing here changes or deletes an event, sets attendees,
 * alarms or a link, or reads anything back. The phone runs the one check the server ran before the
 * card (`checkPhoneEvent`, @rakazo/contracts) again, so an item the server should have refused is
 * never written.
 */

export type PhoneCalendarCreateValue = { created: true; calendar: string };

const MAX_CALENDAR_NAME = 100;

/** The event as the contract allows it; null when the check refuses it. */
export function eventInput(value: unknown, now: number): PhoneEventWrite | null {
  const checked = checkPhoneEvent(value, now);
  return "value" in checked ? checked.value : null;
}

type EventDetails = {
  title?: string;
  startDate?: Date | string;
  endDate?: Date | string;
  allDay?: boolean;
  timeZone?: string;
  location?: string | null;
  notes?: string;
  recurrenceRule?: {
    frequency: string;
    interval?: number;
    occurrence?: number;
    endDate?: Date | string;
  } | null;
};
type TargetCalendar = {
  title?: string | null;
  allowsModifications?: boolean;
  isPrimary?: boolean;
  createEvent(details: EventDetails): Promise<unknown>;
};

/** The part of `expo-calendar` this file uses. */
type CalendarWriteModule = {
  getDefaultCalendarSync(): TargetCalendar;
  getCalendars(entityType?: string): Promise<TargetCalendar[]>;
  EntityTypes: { EVENT: string };
};

let loading: Promise<CalendarWriteModule | null> | undefined;

function loadCalendar(): Promise<CalendarWriteModule | null> {
  if (!calendarAvailable()) return Promise.resolve(null);
  loading ??= import("expo-calendar").then(
    (module): CalendarWriteModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** Whether the system lets the app add events now. Never asks. */
export async function calendarWritePermission(): Promise<PhonePermission> {
  if (!writePermission) return calendarPermission();
  if (!calendarAvailable()) return "unavailable";
  try {
    return (await writePermission.check()) ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Asks the system to add events: iOS's full calendar access, Android's writing on its own. */
export async function requestCalendarWritePermission(): Promise<PhonePermission> {
  if (!writePermission) return requestCalendarPermission();
  if (!calendarAvailable()) return "unavailable";
  try {
    return (await writePermission.request()) ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/**
 * The calendar new events go to. iOS names one; Android has none, so its primary writable calendar
 * is taken, else the first writable one.
 */
async function defaultCalendar(calendar: CalendarWriteModule): Promise<TargetCalendar | undefined> {
  if (Platform.OS !== "android") return calendar.getDefaultCalendarSync();
  const writable = (await calendar.getCalendars(calendar.EntityTypes.EVENT)).filter(
    (entry) => entry.allowsModifications,
  );
  return writable.find((entry) => entry.isPrimary) ?? writable[0];
}

/** A `YYYY-MM-DD` date's year, month (from 0) and day. */
function dayOf(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return [year, month - 1, day];
}

/**
 * When the event starts and ends, as the system takes it. A timed one at its instants. An all-day
 * one on its dates wherever the phone is: iOS takes the phone's own midnight of its first and last
 * days; Android stores all-day events at midnight UTC with the end the day after.
 */
function when(event: PhoneEventWrite): Pick<EventDetails, "startDate" | "endDate" | "timeZone"> {
  if (!event.allDay) return { startDate: new Date(event.start), endDate: new Date(event.end) };
  const [year, month, day] = dayOf(event.start);
  const [endYear, endMonth, endDay] = dayOf(event.end);
  if (Platform.OS === "android")
    return {
      startDate: new Date(Date.UTC(year, month, day)),
      endDate: new Date(Date.UTC(endYear, endMonth, endDay)),
      timeZone: "UTC",
    };
  return {
    startDate: new Date(year, month, day),
    endDate: new Date(endYear, endMonth, endDay - 1),
  };
}

/** The last day of a repeating all-day event, on the same day basis as its start. */
function allDayUntil(until: string): Date {
  const [year, month, day] = dayOf(until);
  return Platform.OS === "android"
    ? new Date(Date.UTC(year, month, day))
    : new Date(year, month, day);
}

function details(event: PhoneEventWrite): EventDetails {
  const { recurrence } = event;
  const until = recurrence?.until;
  return {
    title: event.title,
    ...when(event),
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
    ...(recurrence
      ? {
          recurrenceRule: {
            frequency: recurrence.frequency,
            interval: recurrence.interval,
            ...(recurrence.count !== undefined ? { occurrence: recurrence.count } : {}),
            ...(until ? { endDate: event.allDay ? allDayUntil(until) : new Date(until) } : {}),
          },
        }
      : {}),
  };
}

/** Adds the event; throws `PhoneReadError` with the contract's code when it cannot. */
export async function createCalendarEvent(
  value: unknown,
  now = Date.now(),
): Promise<PhoneCalendarCreateValue> {
  const event = eventInput(value, now);
  if (!event) throw new PhoneReadError("calendar-write-invalid");
  const calendar = await loadCalendar();
  if (!calendar) throw new PhoneReadError("calendar-write-unavailable");
  if ((await calendarWritePermission()) !== "granted") {
    throw new PhoneReadError("calendar-write-permission");
  }
  let target: TargetCalendar | undefined;
  try {
    target = await defaultCalendar(calendar);
    if (target) await target.createEvent(details(event));
  } catch {
    throw new PhoneReadError("calendar-write-unavailable");
  }
  if (!target) throw new PhoneReadError("calendar-write-unavailable");
  return { created: true, calendar: text(target.title, MAX_CALENDAR_NAME) ?? "" };
}
