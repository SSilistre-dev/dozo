/** The built-in tools that read the user's phone (packages/adapters/src/dozo-phone.ts). */
export const PHONE_CALENDAR_READ_TOOL = "phone_calendar_read";
export const PHONE_CONTACTS_SEARCH_TOOL = "phone_contacts_search";
export const PHONE_LOCATION_TOOL = "phone_location";

export const PHONE_TOOL_NAMES = [
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
] as const;

export function isPhoneToolName(name: string): boolean {
  return (PHONE_TOOL_NAMES as readonly string[]).includes(name);
}
