import { withoutLinks } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { readPermission } from "./dozo-phone-read-permission";

/**
 * The phone's calendar, read for a bot through the paired-device connection
 * (`dozo-phone-device.ts`). The native module loads only when it is first needed, and a build
 * without it reads as unavailable. Only the fields of the wire contract ever leave this file: no
 * notes, attendees, links, ids, alarms, recurrence or organizer.
 */

export type PhoneCalendarRequest = { from: string; to: string; query?: string; limit: number };
export type PhoneCalendarEvent = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
};
export type PhoneCalendarValue = { events: PhoneCalendarEvent[]; truncated: boolean };
/** Whether the system lets the app read one kind of the phone's data (shared by every kind). */
export type PhonePermission = "granted" | "denied" | "unavailable";

/** The text of each error frame a read or write of the phone can end with (wire contract). */
export type PhoneReadErrorCode =
  | `${"calendar" | "contacts" | "location" | "reminders" | PhoneWriteKind}-${"off" | "permission" | "unavailable"}`
  | `${PhoneWriteKind}-invalid`
  | "contacts-query"
  | "reminders-write-list";
type PhoneWriteKind = "calendar-write" | "reminders-write";

export class PhoneReadError extends Error {
  override name = "PhoneReadError";
  constructor(readonly code: PhoneReadErrorCode) {
    super(code);
  }
}

const MAX_EVENTS = 50;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 200;
const MAX_CALENDAR_NAME = 100;
const MAX_QUERY = 100;

type NativeEvent = {
  title?: string | null;
  location?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  allDay?: boolean | null;
  calendarId?: string | null;
};

/** The part of `expo-calendar` this file uses. */
type CalendarModule = {
  getCalendarPermissions(): Promise<{ granted: boolean }>;
  requestCalendarPermissions(): Promise<{ granted: boolean }>;
  getCalendars(entityType?: string): Promise<Array<{ id: string; title?: string | null }>>;
  listEvents(calendars: string[], startDate: Date, endDate: Date): Promise<NativeEvent[]>;
  EntityTypes: { EVENT: string };
};

/** Whether this build has the calendar module; an older build hides the setting. */
export function calendarAvailable(): boolean {
  return Platform.OS !== "web" && requireOptionalNativeModule("CalendarNext") != null;
}

let loading: Promise<CalendarModule | null> | undefined;

function loadCalendar(): Promise<CalendarModule | null> {
  if (!calendarAvailable()) return Promise.resolve(null);
  loading ??= import("expo-calendar").then(
    (module): CalendarModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** Whether the system lets the app read the calendar now. Never asks. */
export async function calendarPermission(): Promise<PhonePermission> {
  const calendar = await loadCalendar();
  if (!calendar) return "unavailable";
  try {
    const granted = readPermission
      ? await readPermission.check()
      : (await calendar.getCalendarPermissions()).granted;
    return granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Asks the system for full read access (iOS 17 and later ask for full access, not write-only). */
export async function requestCalendarPermission(): Promise<PhonePermission> {
  const calendar = await loadCalendar();
  if (!calendar) return "unavailable";
  try {
    const granted = readPermission
      ? await readPermission.request()
      : (await calendar.requestCalendarPermissions()).granted;
    return granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/**
 * A text field without its links (a meeting's address often carries its passcode), cut to its
 * limit: the one filter the server applies again (@rakazo/contracts). Cut first too, so a long
 * field costs no more to filter.
 */
export const text = (field: string | null | undefined, max: number): string | undefined =>
  field ? withoutLinks(field.slice(0, 10 * max))?.slice(0, max) : undefined;

export function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The asked window, cut to 31 days; null when it is not one. */
export function range(request: { from: string; to: string }) {
  const from = new Date(request.from);
  const to = new Date(request.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  return { from, to: new Date(Math.min(to.getTime(), from.getTime() + MAX_RANGE_MS)) };
}

/** The contract's value from what the system returned: filtered, sorted, capped, and nothing else. */
export function calendarValue(
  native: readonly NativeEvent[],
  calendarNames: ReadonlyMap<string, string>,
  request: PhoneCalendarRequest,
): PhoneCalendarValue {
  const query = request.query ? request.query.slice(0, MAX_QUERY).toLowerCase() : "";
  const limit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(request.limit) || MAX_EVENTS));
  const matching: Array<PhoneCalendarEvent & { at: number }> = [];
  for (const event of native) {
    const start = iso(event.startDate);
    const end = iso(event.endDate);
    if (!start || !end) continue;
    // A link never leaves the phone, nor answers a search; the rest of the text does.
    const title = text(event.title, MAX_TEXT) ?? "";
    const location = text(event.location, MAX_TEXT) ?? "";
    if (query && !title.toLowerCase().includes(query) && !location.toLowerCase().includes(query)) {
      continue;
    }
    const calendar = text(
      event.calendarId ? calendarNames.get(event.calendarId) : undefined,
      MAX_CALENDAR_NAME,
    );
    matching.push({
      at: Date.parse(start),
      title,
      start,
      end,
      allDay: event.allDay === true,
      ...(location ? { location } : {}),
      ...(calendar ? { calendar } : {}),
    });
  }
  matching.sort((a, b) => a.at - b.at);
  return {
    events: matching.slice(0, limit).map(({ at: _at, ...event }) => event),
    truncated: matching.length > limit,
  };
}

/** Every calendar's events in [from, to); throws `PhoneReadError` when it cannot. */
export async function readCalendar(request: PhoneCalendarRequest): Promise<PhoneCalendarValue> {
  const calendar = await loadCalendar();
  if (!calendar) throw new PhoneReadError("calendar-unavailable");
  if ((await calendarPermission()) !== "granted") {
    throw new PhoneReadError("calendar-permission");
  }
  const window = range(request);
  if (!window) throw new PhoneReadError("calendar-unavailable");
  try {
    const calendars = await calendar.getCalendars(calendar.EntityTypes.EVENT);
    if (!calendars.length) return { events: [], truncated: false };
    const names = new Map(calendars.map((entry) => [entry.id, entry.title ?? ""] as const));
    const ids = calendars.map((entry) => entry.id);
    const events = await calendar.listEvents(ids, window.from, window.to);
    // Events that overlap the window, so one already under way is in it too.
    return calendarValue(events, names, request);
  } catch {
    throw new PhoneReadError("calendar-unavailable");
  }
}
