import { approximateLocation, oneLineText, withoutLinks } from "@rakazo/contracts";
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
const base = {
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
};

export const phoneCalendarReadRequest = z.object({
  ...base,
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

/** How much one contacts search may bring back. */
export const PHONE_CONTACTS_MAX = 10;
export const PHONE_CONTACT_VALUES_MAX = 3;
export const PHONE_CONTACTS_QUERY_MAX = 100;
const CONTACT_TEXT_MAX = 100;
export const PHONE_CONTACT_FIELDS = ["phone", "email"] as const;
export type PhoneContactField = (typeof PHONE_CONTACT_FIELDS)[number];

/**
 * Looks one person up by a part of their name in the phone's contacts and answers their phone
 * numbers or email addresses (PhoneContactsValue), or one of PHONE_CONTACTS_ERRORS.
 */
export const phoneContactsSearchRequest = z.object({
  ...base,
  method: z.literal("phoneContactsSearch"),
  query: z.string().min(2).max(PHONE_CONTACTS_QUERY_MAX),
  field: z.enum(PHONE_CONTACT_FIELDS),
  limit: z.number().int().min(1).max(PHONE_CONTACTS_MAX),
});
export type PhoneContactsSearchRequest = z.infer<typeof phoneContactsSearchRequest>;

export const PHONE_CONTACTS_ERRORS = [
  "contacts-off",
  "contacts-permission",
  "contacts-unavailable",
  "contacts-query",
] as const;

export interface PhoneContact {
  name: string;
  values: string[];
}
export interface PhoneContactsValue {
  contacts: PhoneContact[];
  truncated: boolean;
}

/**
 * A query as the phone matches it and the card shows it (one line, `oneLineText`), or undefined
 * when it could list contacts instead of finding one: fewer than two letters or digits (`*`, `%%`,
 * `..` and spaces have none), or longer than PHONE_CONTACTS_QUERY_MAX.
 */
export function phoneContactsQuery(query: unknown): string | undefined {
  if (typeof query !== "string") return undefined;
  const text = oneLineText(query);
  const meaningful = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return meaningful >= 2 && text.length <= PHONE_CONTACTS_QUERY_MAX ? text : undefined;
}

/** A phone number (digits with the usual separators, an extension or pauses) or an email address. */
const CONTACT_VALUE: Record<PhoneContactField, RegExp> = {
  phone: /^(?=(?:\D*\d){3})[+\d\s().\-/#*,;pwx]+$/i,
  email: /^[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+$/,
};
const contact = z.object({ name: z.string(), values: z.array(z.unknown()) });
const contacts = z.object({ contacts: z.array(z.unknown()), truncated: z.boolean() });

/**
 * The phone's contacts answer as the server passes it on: each well-formed contact's name without
 * links and cut to its limit, and only values of the asked kind, at most PHONE_CONTACT_VALUES_MAX,
 * whatever else the phone sends (addresses, notes, ids, labels never pass). A contact left with
 * no value is dropped. At most PHONE_CONTACTS_MAX of them. Null when it is not an answer at all.
 */
export function phoneContactsValue(
  answer: unknown,
  field: PhoneContactField,
): PhoneContactsValue | null {
  const parsed = contacts.safeParse(answer);
  if (!parsed.success) return null;
  const kept = parsed.data.contacts.flatMap((entry) => {
    const read = contact.safeParse(entry);
    if (!read.success) return [];
    const values = read.data.values
      .flatMap((value) => (typeof value === "string" ? [value.trim()] : []))
      .filter((value) => value.length <= CONTACT_TEXT_MAX && CONTACT_VALUE[field].test(value))
      .slice(0, PHONE_CONTACT_VALUES_MAX);
    if (!values.length) return [];
    return [{ name: text(read.data.name, CONTACT_TEXT_MAX) ?? "", values }];
  });
  return {
    contacts: kept.slice(0, PHONE_CONTACTS_MAX),
    truncated: parsed.data.truncated || kept.length > PHONE_CONTACTS_MAX,
  };
}

export const PHONE_LOCATION_PRECISIONS = ["approximate", "precise"] as const;
export type PhoneLocationPrecision = (typeof PHONE_LOCATION_PRECISIONS)[number];

/** One reading of where the phone is (PhoneLocationValue), or one of PHONE_LOCATION_ERRORS. */
export const phoneLocationRequest = z.object({
  ...base,
  method: z.literal("phoneLocation"),
  precision: z.enum(PHONE_LOCATION_PRECISIONS),
});
export type PhoneLocationRequest = z.infer<typeof phoneLocationRequest>;

export const PHONE_LOCATION_ERRORS = [
  "location-off",
  "location-permission",
  "location-unavailable",
] as const;

export interface PhoneLocationValue {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  precise: boolean;
  at: string;
}

const location = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().min(0),
  precise: z.boolean(),
  at: instant,
});

/**
 * The phone's location answer as the server passes it on. Its `at` is the phone's clock, passed
 * on as information only: how fresh a reading is, the server measures itself (`phoneRead`).
 * Full accuracy only when precise was asked for and the phone says it gave it; anything else is
 * rounded here again to about a kilometre (`approximateLocation`, as the phone rounds it), whatever
 * the phone sent. Null when it is not an answer at all.
 */
export function phoneLocationValue(
  answer: unknown,
  precision: PhoneLocationPrecision,
): PhoneLocationValue | null {
  const parsed = location.safeParse(answer);
  if (!parsed.success) return null;
  const { latitude, longitude, accuracyMeters, precise, at } = parsed.data;
  if (precision === "precise" && precise)
    return { latitude, longitude, accuracyMeters, precise, at };
  return {
    ...approximateLocation(latitude, longitude, accuracyMeters),
    precise: false,
    at,
  };
}
