import type { PhoneReminderWrite } from "@rakazo/contracts";
import { checkPhoneReminder } from "@rakazo/contracts";
import { PhoneReadError } from "./dozo-phone-calendar";
import {
  listName,
  remindersAvailable,
  remindersPermission,
  sameList,
} from "./dozo-phone-reminders";

/**
 * Adds one reminder the user approved (wire contract: `phoneReminderCreate`), iOS only, to the
 * named list when the phone has one, else to the default list. Create only: nothing here changes
 * or deletes a reminder or sets alarms, a link or a repeat. The only thing read back is which list
 * the system chose, to name it in the answer. The one check the server ran before the card
 * (`checkPhoneReminder`, @rakazo/contracts) runs here again.
 */

export type PhoneReminderCreateValue = { created: true; list: string };

/** The reminder as the contract allows it; null when the check refuses it. */
export function reminderInput(value: unknown): PhoneReminderWrite | null {
  const checked = checkPhoneReminder(value);
  return "value" in checked ? checked.value : null;
}

/** The part of `expo-calendar/legacy` this file uses: it is the one that adds to the default list. */
type RemindersWriteModule = {
  getCalendarsAsync(entityType?: string): Promise<Array<{ id: string; title?: string | null }>>;
  createReminderAsync(
    listId: string | null,
    details: { title?: string; dueDate?: Date; notes?: string },
  ): Promise<string>;
  getReminderAsync(id: string): Promise<{ calendarId?: string }>;
  EntityTypes: { REMINDER: string };
};

let loading: Promise<RemindersWriteModule | null> | undefined;

function loadReminders(): Promise<RemindersWriteModule | null> {
  if (!remindersAvailable()) return Promise.resolve(null);
  loading ??= import("expo-calendar/legacy").then(
    (module): RemindersWriteModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** Adds the reminder; throws `PhoneReadError` with the contract's code when it cannot. */
export async function createReminder(value: unknown): Promise<PhoneReminderCreateValue> {
  const reminder = reminderInput(value);
  if (!reminder) throw new PhoneReadError("reminders-write-invalid");
  const module = await loadReminders();
  if (!module) throw new PhoneReadError("reminders-write-unavailable");
  if ((await remindersPermission()) !== "granted") {
    throw new PhoneReadError("reminders-write-permission");
  }
  let lists: Array<{ id: string; title?: string | null }>;
  let id: string;
  const { list: asked } = reminder;
  try {
    lists = await module.getCalendarsAsync(module.EntityTypes.REMINDER);
    const named = asked ? lists.find((entry) => sameList(entry.title, asked)) : undefined;
    id = await module.createReminderAsync(named?.id ?? null, {
      title: reminder.title,
      ...(reminder.due ? { dueDate: new Date(reminder.due) } : {}),
      ...(reminder.notes ? { notes: reminder.notes } : {}),
    });
    if (named) return { created: true, list: listName(named.title) };
  } catch {
    throw new PhoneReadError("reminders-write-unavailable");
  }
  // Written: a list that cannot be named now still answers created, so it is not added twice.
  const chosen = await module.getReminderAsync(id).then(
    (created) => lists.find((entry) => entry.id === created.calendarId)?.title,
    () => undefined,
  );
  return { created: true, list: listName(chosen) };
}
