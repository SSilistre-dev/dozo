import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
  PHONE_REMINDERS_READ_TOOL,
} from "@rakazo/contracts";

export {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
  PHONE_REMINDERS_READ_TOOL,
  PHONE_TOOL_NAMES,
  PHONE_WRITE_TOOL_NAMES,
} from "@rakazo/contracts";

/** Reads the calendar on the user's phone (dozo-phone.ts). */
export const phoneCalendarReadTool: ConnectorTool = {
  name: PHONE_CALENDAR_READ_TOOL,
  description:
    "Read the events on the user's phone calendar from `from` to `to`, at most 31 days apart. Give both as ISO 8601 times with an offset, such as 2026-03-02T09:00:00+01:00.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start of the range, ISO 8601 with an offset." },
      to: { type: "string", description: "End of the range, ISO 8601 with an offset." },
      query: {
        type: "string",
        description: "Only events whose title or location contains this.",
        maxLength: 100,
      },
    },
    required: ["from", "to"],
  },
};

/** Looks one person up in the contacts on the user's phone (dozo-phone.ts). */
export const phoneContactsSearchTool: ConnectorTool = {
  name: PHONE_CONTACTS_SEARCH_TOOL,
  description:
    "Look up one person by name in the user's phone contacts for their phone numbers or email addresses; not for listing contacts.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Part of the person's name, at least two letters or digits.",
        maxLength: 100,
      },
      field: { type: "string", enum: ["phone", "email"], description: "What to return." },
    },
    required: ["query", "field"],
  },
};

/** Reads where the user's phone is, once (dozo-phone.ts). */
export const phoneLocationTool: ConnectorTool = {
  name: PHONE_LOCATION_TOOL,
  description:
    "Read where the user's phone is right now, once. Ask for precise only when about a kilometre is not enough; the user approves every reading.",
  inputSchema: {
    type: "object",
    properties: {
      precision: {
        type: "string",
        enum: ["approximate", "precise"],
        description: "approximate (about 1 km, the default) or precise.",
      },
    },
  },
};

/** Reads the reminders on the user's phone (dozo-phone.ts). */
export const phoneRemindersReadTool: ConnectorTool = {
  name: PHONE_REMINDERS_READ_TOOL,
  description:
    "Read the reminders on the user's phone, open ones by default. To read those due in a range, give both due_from and due_to, at most 31 days apart, as ISO 8601 times with an offset.",
  inputSchema: {
    type: "object",
    properties: {
      list: { type: "string", description: "Only this list's reminders.", maxLength: 100 },
      due_from: { type: "string", description: "Start of the due range, ISO 8601 with an offset." },
      due_to: { type: "string", description: "End of the due range, ISO 8601 with an offset." },
      include_done: { type: "boolean", description: "Completed reminders too." },
    },
  },
};

const ISO = "ISO 8601 with an offset, such as 2026-03-02T09:00:00+01:00.";

/** Adds one event to the calendar on the user's phone (dozo-phone.ts). */
export const phoneCalendarCreateTool: ConnectorTool = {
  name: PHONE_CALENDAR_CREATE_TOOL,
  description:
    "Add one event to the user's phone calendar. It only creates: it cannot change or delete an event, and it has no invitees. The user approves every write; a repeating event must end.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      start: { type: "string", description: `${ISO} For an all-day event, a date: 2026-03-01.` },
      end: {
        type: "string",
        description:
          "Like start, at most 31 days after it. For an all-day event, the day after its last day.",
      },
      all_day: { type: "boolean" },
      location: { type: "string", maxLength: 200 },
      notes: { type: "string", maxLength: 1000 },
      recurrence: {
        type: "object",
        description: "How it repeats: give count or until, not both.",
        properties: {
          frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
          interval: {
            type: "integer",
            minimum: 1,
            maximum: 30,
            description: "Every n periods; 1 by default.",
          },
          count: { type: "integer", minimum: 1, maximum: 365 },
          until: { type: "string", description: "Written as start is." },
        },
        required: ["frequency"],
        additionalProperties: false,
      },
    },
    required: ["title", "start", "end"],
    additionalProperties: false,
  },
};

/** Adds one reminder on the user's phone (dozo-phone.ts). */
export const phoneReminderCreateTool: ConnectorTool = {
  name: PHONE_REMINDER_CREATE_TOOL,
  description:
    "Add one reminder on the user's phone. It only creates: it cannot change or delete a reminder. The user approves every write.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      due: { type: "string", description: ISO },
      notes: { type: "string", maxLength: 1000 },
      list: {
        type: "string",
        description: "An existing list's name; the default list otherwise.",
        maxLength: 100,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};
