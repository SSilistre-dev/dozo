import type { PhoneEventWrite, PhoneRecurrence, PhoneReminderWrite } from "@rakazo/contracts";
import { checkPhoneEvent, checkPhoneReminder, oneLineText } from "@rakazo/contracts";
import type { PhoneRemindersReadRequest } from "./dozo-phone-protocol.js";
import {
  isoInstant,
  PHONE_LIST_NAME_MAX,
  PHONE_REMINDERS_MAX_DAYS,
} from "./dozo-phone-protocol.js";

/**
 * The arguments of the phone's reminders read and of its writes, as the server reads them before
 * any card: what the phone is sent, and for a write the lines its card shows. A write's text is
 * made what it will be first (one line, or plain notes); then the one check the phone runs too
 * (`checkPhoneEvent`, `checkPhoneReminder` in @rakazo/contracts) says whether it may be written, so
 * the card shows exactly what is sent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
type Refused = { error: string };
/** A value read from the arguments, or why it cannot be. */
type Read<T> = { value: T } | Refused;
const ISO_EXAMPLE = "ISO 8601 with an offset, such as 2026-03-02T09:00:00+01:00";

/** A value the model left out: absent, or null as models often send it. */
const absent = (value: unknown) => value === undefined || value === null;

/** An optional text as one line, at most `max` long; undefined when absent or empty. */
function oneLine(
  args: Record<string, unknown>,
  key: string,
  max: number,
): Read<string | undefined> {
  const value = args[key];
  if (absent(value)) return { value: undefined };
  if (typeof value !== "string") return { error: `${key} must be text.` };
  const line = oneLineText(value);
  if (line.length > max) return { error: `${key} can be at most ${max} characters.` };
  return { value: line || undefined };
}

/** An optional true or false. */
function flag(args: Record<string, unknown>, key: string): Read<boolean> {
  const value = args[key];
  if (absent(value)) return { value: false };
  if (typeof value !== "boolean") return { error: `${key} must be true or false.` };
  return { value };
}

/** A text the model gave as one line; anything else as given, for the check to refuse. */
const line = (value: unknown) =>
  typeof value === "string" ? oneLineText(value) || undefined : value;

/**
 * Notes as plain text: line breaks kept (as \n), tabs as spaces, every other control or format
 * character (bidi controls, zero-width ones) dropped, so the card shows them as the phone stores
 * them. Anything that is not text is passed on as given, for the check to refuse.
 */
function plainNotes(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value
    .normalize("NFKC")
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[^\P{Cc}\n]|\p{Cf}/gu, "")
    .trim();
  return text || undefined;
}

/** The given fields only: what the model left out (or sent as null) is not on the wire. */
function given(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !absent(value)));
}

/** A key the tool does not take, named so the model can drop it. */
function unknownKey(args: Record<string, unknown>, known: readonly string[], fields: string) {
  const key = Object.keys(args).find((name) => !known.includes(name));
  return key === undefined
    ? undefined
    : { error: `"${key}" is not accepted. Give only ${fields}: this tool only creates.` };
}

/** What a reminders read asks the phone for, besides the bot, the run and the limit. */
export type RemindersReadInput = Omit<
  PhoneRemindersReadRequest,
  "botId" | "runId" | "method" | "limit"
>;

/** The list, due range and done flag of a reminders read, or why they cannot be read. */
export function remindersReadInput(args: Record<string, unknown>): RemindersReadInput | Refused {
  const list = oneLine(args, "list", PHONE_LIST_NAME_MAX);
  if ("error" in list) return list;
  const done = flag(args, "include_done");
  if ("error" in done) return done;
  const given = [args.due_from, args.due_to].filter((value) => !absent(value)).length;
  if (given === 1) return { error: "due_from and due_to go together: give both or neither." };
  let due: RemindersReadInput["due"];
  if (given === 2) {
    const from = isoInstant(args.due_from);
    const to = isoInstant(args.due_to);
    if (!from || !to) return { error: `due_from and due_to must be ${ISO_EXAMPLE}.` };
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0) return { error: "due_to must be after due_from." };
    if (span > PHONE_REMINDERS_MAX_DAYS * DAY_MS)
      return {
        error: `The due range can be at most ${PHONE_REMINDERS_MAX_DAYS} days; read it in parts.`,
      };
    due = { from, to };
  }
  return {
    ...(list.value ? { list: list.value } : {}),
    ...(due ? { due } : {}),
    includeDone: done.value,
  };
}

/** The lines a reminders read's card shows: the range, the list, and whether done ones too. */
export function remindersReadDetail(input: RemindersReadInput): string {
  return [
    ...(input.due ? [`${input.due.from} – ${input.due.to}`] : []),
    ...(input.list ? [input.list] : []),
    ...(input.includeDone ? ["Completed too"] : []),
  ].join("\n");
}

const EVENT_KEYS = ["title", "start", "end", "all_day", "location", "notes", "recurrence"];
const REMINDER_KEYS = ["title", "due", "notes", "list"];

/** A write to the phone: what it sends there and the lines its card shows, the same values. */
export type PhoneWrite<T> = { item: T; lines: string[] };

/**
 * An event to create on the phone, from a calendar write's arguments, or why it cannot be: any
 * argument besides EVENT_KEYS (an attendee, an id) is refused, and then whatever `checkPhoneEvent`
 * refuses. An all-day event is given by its dates (end exclusive), a timed one by times with an
 * offset.
 */
export function calendarCreateInput(
  args: Record<string, unknown>,
  now = Date.now(),
): PhoneWrite<PhoneEventWrite> | Refused {
  const unknown = unknownKey(args, EVENT_KEYS, EVENT_KEYS.join(", "));
  if (unknown) return unknown;
  const allDay = absent(args.all_day) ? false : args.all_day;
  if (typeof allDay !== "boolean") return { error: "all_day must be true or false." };
  const { recurrence } = args;
  const repeats =
    recurrence && typeof recurrence === "object" && !Array.isArray(recurrence)
      ? given({ interval: 1, ...(recurrence as Record<string, unknown>) })
      : recurrence;
  const checked = checkPhoneEvent(
    given({
      title: line(args.title),
      start: typeof args.start === "string" ? args.start.trim() : args.start,
      end: typeof args.end === "string" ? args.end.trim() : args.end,
      allDay,
      location: line(args.location),
      notes: plainNotes(args.notes),
      recurrence: repeats,
    }),
    now,
  );
  if ("error" in checked) return checked;
  const item = checked.value;
  return {
    item,
    lines: [
      `Title: ${item.title}`,
      `Starts: ${item.start}`,
      `Ends: ${item.end}`,
      `All day: ${item.allDay ? "yes" : "no"}`,
      ...(item.location ? [`Location: ${item.location}`] : []),
      ...(item.recurrence ? [`Repeats: ${repeatsInWords(item.recurrence)}`] : []),
      ...(item.notes ? ["Notes:", item.notes] : []),
    ],
  };
}

const PERIODS = { daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const;

/** "every 2 weeks, 10 times", "every day, until …". */
function repeatsInWords(recurrence: PhoneRecurrence): string {
  const period = PERIODS[recurrence.frequency];
  const every =
    recurrence.interval === 1 ? `every ${period}` : `every ${recurrence.interval} ${period}s`;
  const ends =
    recurrence.count !== undefined
      ? `${recurrence.count} ${recurrence.count === 1 ? "time" : "times"}`
      : `until ${recurrence.until}`;
  return `${every}, ${ends}`;
}

/** A reminder to create on the phone, from a reminder write's arguments, or why it cannot be. */
export function reminderCreateInput(
  args: Record<string, unknown>,
): PhoneWrite<PhoneReminderWrite> | Refused {
  const unknown = unknownKey(args, REMINDER_KEYS, REMINDER_KEYS.join(", "));
  if (unknown) return unknown;
  const checked = checkPhoneReminder(
    given({
      title: line(args.title),
      due: typeof args.due === "string" ? args.due.trim() : args.due,
      notes: plainNotes(args.notes),
      list: line(args.list),
    }),
  );
  if ("error" in checked) return checked;
  const item = checked.value;
  return {
    item,
    lines: [
      `Title: ${item.title}`,
      ...(item.due ? [`Due: ${item.due}`] : []),
      ...(item.list ? [`List: ${item.list}`] : []),
      ...(item.notes ? ["Notes:", item.notes] : []),
    ],
  };
}
