import type { ConnectorTool } from "@rakazo/adapter-kit";

export const PHONE_CALENDAR_READ_TOOL = "phone_calendar_read";

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
