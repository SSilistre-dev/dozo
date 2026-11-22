import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
} from "@rakazo/contracts";

export {
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_TOOL_NAMES,
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
