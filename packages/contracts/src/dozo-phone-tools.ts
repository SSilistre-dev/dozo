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

/**
 * Text a model wrote, as one line (NFKC): every run of white space, line breaks and tabs included,
 * becomes one space, and other control and format characters (bidi controls, zero-width ones) are
 * dropped. A contacts query passes through it on the server and the phone alike, so on the
 * approval card it cannot fake a line or push the real one out of sight.
 */
export function oneLineText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}
