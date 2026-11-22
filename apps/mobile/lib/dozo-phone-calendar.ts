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
export type CalendarPermission = "granted" | "denied" | "unavailable";

/** The text of each error frame a calendar read can end with. */
export type PhoneCalendarErrorCode =
  | "calendar-off"
  | "calendar-permission"
  | "calendar-unavailable";

export class PhoneCalendarError extends Error {
  override name = "PhoneCalendarError";
  constructor(readonly code: PhoneCalendarErrorCode) {
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
export async function calendarPermission(): Promise<CalendarPermission> {
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
export async function requestCalendarPermission(): Promise<CalendarPermission> {
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

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function range(request: PhoneCalendarRequest) {
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
  const query = request.query ? cut(request.query, MAX_QUERY).toLowerCase() : "";
  const limit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(request.limit) || MAX_EVENTS));
  const matching: Array<PhoneCalendarEvent & { at: number }> = [];
  for (const event of native) {
    const start = iso(event.startDate);
    const end = iso(event.endDate);
    if (!start || !end) continue;
    const title = event.title ?? "";
    const location = event.location ?? "";
    if (query && !title.toLowerCase().includes(query) && !location.toLowerCase().includes(query)) {
      continue;
    }
    const calendar = event.calendarId ? calendarNames.get(event.calendarId) : undefined;
    matching.push({
      at: Date.parse(start),
      title: cut(title, MAX_TEXT),
      start,
      end,
      allDay: event.allDay === true,
      ...(location ? { location: cut(location, MAX_TEXT) } : {}),
      ...(calendar ? { calendar: cut(calendar, MAX_CALENDAR_NAME) } : {}),
    });
  }
  matching.sort((a, b) => a.at - b.at);
  return {
    events: matching.slice(0, limit).map(({ at: _at, ...event }) => event),
    truncated: matching.length > limit,
  };
}

/** Every calendar's events in [from, to); throws `PhoneCalendarError` when it cannot. */
export async function readCalendar(request: PhoneCalendarRequest): Promise<PhoneCalendarValue> {
  const calendar = await loadCalendar();
  if (!calendar) throw new PhoneCalendarError("calendar-unavailable");
  if ((await calendarPermission()) !== "granted") {
    throw new PhoneCalendarError("calendar-permission");
  }
  const window = range(request);
  if (!window) throw new PhoneCalendarError("calendar-unavailable");
  try {
    const calendars = await calendar.getCalendars(calendar.EntityTypes.EVENT);
    if (!calendars.length) return { events: [], truncated: false };
    const names = new Map(calendars.map((entry) => [entry.id, entry.title ?? ""] as const));
    const ids = calendars.map((entry) => entry.id);
    const events = await calendar.listEvents(ids, window.from, window.to);
    // Events that overlap the window, so one already under way is in it too.
    return calendarValue(events, names, request);
  } catch {
    throw new PhoneCalendarError("calendar-unavailable");
  }
}
