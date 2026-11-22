import { withoutLinks } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import type { PhonePermission } from "./dozo-phone-calendar";
import { PhoneReadError } from "./dozo-phone-calendar";

/**
 * The phone's contacts, searched for a bot by name through the paired-device connection
 * (`dozo-phone-device.ts`). The native module loads only when it is first needed, and a build
 * without it reads as unavailable. The system is asked for the display name and the one kind of
 * value requested, and only the wire contract's fields leave this file: no addresses, birthdays,
 * notes, photos, company, relations, ids or labels.
 */

export type PhoneContactsField = "phone" | "email";
export type PhoneContactsRequest = { query: string; field: PhoneContactsField; limit: number };
export type PhoneContact = { name: string; values: string[] };
export type PhoneContactsValue = { contacts: PhoneContact[]; truncated: boolean };

const MAX_CONTACTS = 10;
const MAX_VALUES = 3;
const MAX_TEXT = 100;
const MAX_QUERY = 100;

type NativeContact = {
  fullName?: string | null;
  phones?: ReadonlyArray<{ number?: string | null }> | null;
  emails?: ReadonlyArray<{ address?: string | null }> | null;
};

/** The part of `expo-contacts` this file uses. */
type ContactsModule = {
  getPermissionsAsync(): Promise<{ granted: boolean }>;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  Contact: { getAllDetails(fields: readonly string[]): Promise<readonly NativeContact[]> };
  ContactField: { FULL_NAME: string; PHONES: string; EMAILS: string };
};

/** Whether this build has the contacts module; an older build hides the setting. */
export function contactsAvailable(): boolean {
  return Platform.OS !== "web" && requireOptionalNativeModule("ExpoContactsNext") != null;
}

let loading: Promise<ContactsModule | null> | undefined;

function loadContacts(): Promise<ContactsModule | null> {
  if (!contactsAvailable()) return Promise.resolve(null);
  loading ??= import("expo-contacts").then(
    (module): ContactsModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** Whether the system lets the app read contacts now. Never asks. */
export async function contactsPermission(): Promise<PhonePermission> {
  const contacts = await loadContacts();
  if (!contacts) return "unavailable";
  try {
    return (await contacts.getPermissionsAsync()).granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Asks the system to read contacts (a limited selection on iOS counts as granted). */
export async function requestContactsPermission(): Promise<PhonePermission> {
  const contacts = await loadContacts();
  if (!contacts) return "unavailable";
  try {
    return (await contacts.requestPermissionsAsync()).granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/**
 * The query as it is matched: trimmed and in one form (NFKC), or null unless it has two letters or
 * digits, so a wildcard or punctuation alone (`*`, `%`, `..`) never lists the address book.
 */
export function contactsQuery(query: string): string | null {
  const kept = query.normalize("NFKC").trim();
  return (kept.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2 ? kept : null;
}

/** Case and accents left out, so "zoe" finds "Zoë". */
const folded = (text: string) =>
  text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** The name without its links, cut to its limit; cut first too, so a long name costs no more. */
const displayName = (name: string | null | undefined): string | undefined =>
  name ? withoutLinks(name.slice(0, 10 * MAX_TEXT))?.slice(0, MAX_TEXT) : undefined;

function values(contact: NativeContact, field: PhoneContactsField): string[] {
  const raw =
    field === "phone"
      ? (contact.phones ?? []).map((entry) => entry.number)
      : (contact.emails ?? []).map((entry) => entry.address);
  return raw
    .map((value) => value?.trim().slice(0, MAX_TEXT) ?? "")
    .filter(Boolean)
    .slice(0, MAX_VALUES);
}

/** The contract's value from what the system returned: matched, sorted, capped, and nothing else. */
export function contactsValue(
  native: readonly NativeContact[],
  request: PhoneContactsRequest,
): PhoneContactsValue {
  const query = contactsQuery(request.query);
  if (!query) throw new PhoneReadError("contacts-query");
  const wanted = folded(query.slice(0, MAX_QUERY));
  const limit = Math.max(1, Math.min(MAX_CONTACTS, Math.floor(request.limit) || MAX_CONTACTS));
  const matching: PhoneContact[] = [];
  for (const contact of native) {
    // A link never leaves the phone, nor answers a search: the name is matched as it is sent.
    const name = displayName(contact.fullName);
    if (!name || !folded(name).includes(wanted)) continue;
    matching.push({ name, values: values(contact, request.field) });
  }
  matching.sort((a, b) => a.name.localeCompare(b.name));
  return { contacts: matching.slice(0, limit), truncated: matching.length > limit };
}

/** Contacts whose name holds the query; throws `PhoneReadError` when it cannot answer. */
export async function searchContacts(request: PhoneContactsRequest): Promise<PhoneContactsValue> {
  if (!contactsQuery(request.query)) throw new PhoneReadError("contacts-query");
  const contacts = await loadContacts();
  if (!contacts) throw new PhoneReadError("contacts-unavailable");
  if ((await contactsPermission()) !== "granted") throw new PhoneReadError("contacts-permission");
  const { FULL_NAME, PHONES, EMAILS } = contacts.ContactField;
  let native: readonly NativeContact[];
  try {
    // The name is matched here, not by the system, which matches the start of a word only.
    native = await contacts.Contact.getAllDetails([
      FULL_NAME,
      request.field === "phone" ? PHONES : EMAILS,
    ]);
  } catch {
    throw new PhoneReadError("contacts-unavailable");
  }
  return contactsValue(native, request);
}
