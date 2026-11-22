import { withoutLinks } from "@rakazo/contracts";
import { z } from "zod";

/** The platforms a phone pairs as. Anything else that pairs is a computer. */
export const PHONE_PLATFORMS = ["ios", "android"] as const;

export function isPhonePlatform(platform: string): boolean {
  return (PHONE_PLATFORMS as readonly string[]).includes(platform);
}

/** How much of the phone's calendar one read may ask for and bring back. */
export const PHONE_CALENDAR_MAX_DAYS = 31;
export const PHONE_CALENDAR_MAX_EVENTS = 50;
export const PHONE_CALENDAR_QUERY_MAX = 100;
const FIELD_MAX = 200;
const CALENDAR_NAME_MAX = 100;

/**
 * Reads the events of every calendar on the user's phone in [from, to), those whose title or
 * location holds `query` when given, sorted by start, the first `limit`. The phone answers one
 * value (PhoneCalendarValue) and done, or one of PHONE_CALENDAR_ERRORS.
 */
export const phoneCalendarReadRequest = z.object({
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
  method: z.literal("phoneCalendarRead"),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  query: z.string().max(PHONE_CALENDAR_QUERY_MAX).optional(),
  limit: z.number().int().min(1).max(PHONE_CALENDAR_MAX_EVENTS),
});
export type PhoneCalendarReadRequest = z.infer<typeof phoneCalendarReadRequest>;

/** The texts of the phone's error frame for a calendar read. */
export const PHONE_CALENDAR_ERRORS = [
  "calendar-off",
  "calendar-permission",
  "calendar-unavailable",
] as const;

export interface PhoneCalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
}
export interface PhoneCalendarValue {
  events: PhoneCalendarEvent[];
  truncated: boolean;
}

const instant = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)));
const event = z.object({
  title: z.string(),
  start: instant,
  end: instant,
  allDay: z.boolean(),
  location: z.string().optional(),
  calendar: z.string().optional(),
});
const value = z.object({ events: z.array(z.unknown()), truncated: z.boolean() });

/**
 * A text field without its links (the one filter the phone uses too, @rakazo/contracts), cut to
 * its limit; what the phone sent is cut first, so a long field costs no more to filter.
 */
function text(field: string | undefined, max: number): string | undefined {
  return field ? withoutLinks(field.slice(0, 10 * max))?.slice(0, max) : undefined;
}

/**
 * The phone's answer as the server passes it on: never trusted as sent. Only the known fields of
 * each well-formed event are kept (no notes, attendees or ids, whatever the phone sends), links
 * taken out of their text and each cut to its limit, and at most PHONE_CALENDAR_MAX_EVENTS of them. Null when it is not an
 * answer at all.
 */
export function phoneCalendarValue(answer: unknown): PhoneCalendarValue | null {
  const parsed = value.safeParse(answer);
  if (!parsed.success) return null;
  const events = parsed.data.events.flatMap((entry) => {
    const read = event.safeParse(entry);
    if (!read.success) return [];
    const { start, end, allDay } = read.data;
    const location = text(read.data.location, FIELD_MAX);
    const calendar = text(read.data.calendar, CALENDAR_NAME_MAX);
    return [
      {
        title: text(read.data.title, FIELD_MAX) ?? "",
        start,
        end,
        allDay,
        ...(location ? { location } : {}),
        ...(calendar ? { calendar } : {}),
      },
    ];
  });
  return {
    events: events.slice(0, PHONE_CALENDAR_MAX_EVENTS),
    truncated: parsed.data.truncated || events.length > PHONE_CALENDAR_MAX_EVENTS,
  };
}
