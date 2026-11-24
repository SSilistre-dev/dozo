import { oneLineText, PHONE_WRITE_LIMITS } from "@rakazo/contracts";
import { Platform } from "react-native";
import type { PhonePermission } from "./dozo-phone-calendar";
import { calendarAvailable, iso, PhoneReadError, range, text } from "./dozo-phone-calendar";

/**
 * The phone's reminders, read for a bot through the paired-device connection
 * (`dozo-phone-device.ts`). iOS only: Android keeps no system reminders. They come through the
 * calendar module, loaded only when first needed. Only the wire contract's fields leave this file:
 * no notes, links, ids, location, priority or alarms.
 */

export type PhoneRemindersRequest = {
  list?: string;
  due?: { from: string; to: string };
  includeDone: boolean;
  limit: number;
};
export type PhoneReminder = { title: string; due?: string; done: boolean; list?: string };
export type PhoneRemindersValue = { reminders: PhoneReminder[]; truncated: boolean };

const MAX_REMINDERS = 50;
const MAX_TEXT = 200;
export const MAX_LIST_NAME = PHONE_WRITE_LIMITS.list;

type NativeReminder = {
  title?: string | null;
  dueDate?: string | Date | null;
  completed?: boolean | null;
};
type NativeList = {
  title?: string | null;
  listReminders(startDate: null, endDate: null, status: null): Promise<NativeReminder[]>;
};

/** The part of `expo-calendar` this file uses. */
type RemindersModule = {
  getRemindersPermissions(): Promise<{ granted: boolean }>;
  requestRemindersPermissions(): Promise<{ granted: boolean }>;
  getCalendars(entityType?: string): Promise<NativeList[]>;
  EntityTypes: { REMINDER: string };
};

/** Whether this phone has reminders the app can reach: iOS, in a build with the calendar module. */
export function remindersAvailable(): boolean {
  return Platform.OS === "ios" && calendarAvailable();
}

let loading: Promise<RemindersModule | null> | undefined;

function loadReminders(): Promise<RemindersModule | null> {
  if (!remindersAvailable()) return Promise.resolve(null);
  loading ??= import("expo-calendar").then(
    (module): RemindersModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** Whether the system lets the app use reminders now. Never asks. */
export async function remindersPermission(): Promise<PhonePermission> {
  const reminders = await loadReminders();
  if (!reminders) return "unavailable";
  try {
    return (await reminders.getRemindersPermissions()).granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Asks the system for reminders, apart from the calendar. */
export async function requestRemindersPermission(): Promise<PhonePermission> {
  const reminders = await loadReminders();
  if (!reminders) return "unavailable";
  try {
    return (await reminders.requestRemindersPermissions()).granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** A list's name as the bot sees it (without links), for matching a name it asks for. */
export const listName = (name: string | null | undefined) => text(name, MAX_LIST_NAME) ?? "";
export const sameList = (name: string | null | undefined, asked: string) =>
  oneLineText(listName(name)).toLowerCase() ===
  oneLineText(asked).slice(0, MAX_LIST_NAME).toLowerCase();

/** The contract's value from what the system returned: filtered, sorted, capped, and nothing else. */
export function remindersValue(
  native: ReadonlyArray<{ reminder: NativeReminder; list?: string | null }>,
  request: Pick<PhoneRemindersRequest, "includeDone" | "limit">,
  window: { from: Date; to: Date } | null,
): PhoneRemindersValue {
  const limit = Math.max(1, Math.min(MAX_REMINDERS, Math.floor(request.limit) || MAX_REMINDERS));
  const matching: Array<PhoneReminder & { at: number }> = [];
  for (const { reminder, list } of native) {
    const done = reminder.completed === true;
    if (done && !request.includeDone) continue;
    const due = iso(reminder.dueDate);
    const at = due ? Date.parse(due) : Number.POSITIVE_INFINITY;
    if (window && !(at >= window.from.getTime() && at < window.to.getTime())) continue;
    const name = listName(list);
    matching.push({
      at,
      title: text(reminder.title, MAX_TEXT) ?? "",
      ...(due ? { due } : {}),
      done,
      ...(name ? { list: name } : {}),
    });
  }
  // Undated last; a stable sort keeps the system's order among equals.
  matching.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
  return {
    reminders: matching.slice(0, limit).map(({ at: _at, ...reminder }) => reminder),
    truncated: matching.length > limit,
  };
}

/** Every list's reminders, or the named list's; throws `PhoneReadError` when it cannot. */
export async function readReminders(request: PhoneRemindersRequest): Promise<PhoneRemindersValue> {
  const reminders = await loadReminders();
  if (!reminders) throw new PhoneReadError("reminders-unavailable");
  if ((await remindersPermission()) !== "granted") {
    throw new PhoneReadError("reminders-permission");
  }
  const window = request.due ? range(request.due) : null;
  if (request.due && !window) throw new PhoneReadError("reminders-unavailable");
  try {
    const lists = await reminders.getCalendars(reminders.EntityTypes.REMINDER);
    const { list: asked } = request;
    const found: Array<{ reminder: NativeReminder; list?: string | null }> = [];
    for (const list of asked ? lists.filter((entry) => sameList(entry.title, asked)) : lists) {
      for (const reminder of await list.listReminders(null, null, null)) {
        found.push({ reminder, list: list.title });
      }
    }
    return remindersValue(found, request, window);
  } catch {
    throw new PhoneReadError("reminders-unavailable");
  }
}
