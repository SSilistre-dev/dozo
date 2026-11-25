import { DEFAULT_LOGIN_FIELD_LABELS, sameLoginFieldLabel } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { z } from "zod";
import type { VaultItemUse } from "./secrets/bot-secrets.js";

/**
 * A vault login whose value stays in a password manager on one of the user's own computers. The
 * vault stores only which computer and the handle that computer keeps its link under: the server
 * never holds, decrypts, logs or sends a value, and the model never sees one. The bot's tools are
 * unchanged (`list_secrets`, `browser_act` `fill_secret` and `fill_code`); only where the value
 * comes from differs, and only the user's own browser on that computer can use it
 * (dozo-device-fill.ts, dozo-device-browser.ts).
 */
export const DEVICE_LOGIN_ONLY = "This login can only be filled in your own computer's browser.";

/** The handle a computer keeps a link under: 22 random URL-safe characters. */
export const DEVICE_HANDLE = /^[A-Za-z0-9_-]{22}$/;

const DeviceLink = z.strictObject({
  deviceId: z.string().min(1).max(64),
  handle: z.string().regex(DEVICE_HANDLE),
});
const StoredDeviceLogin = z.strictObject({ deviceLogin: DeviceLink });
export type DeviceLogin = z.infer<typeof DeviceLink>;

/** What the vault stores for a linked login. */
export function encodeDeviceLogin(link: DeviceLogin): string {
  return JSON.stringify(StoredDeviceLogin.parse({ deviceLogin: link }));
}

/** The link a stored value is, or undefined for any other value (a login, a card, a key). */
export function deviceLoginOf(plaintext: string): DeviceLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  const stored = StoredDeviceLogin.safeParse(parsed);
  return stored.success ? stored.data.deviceLogin : undefined;
}

export type DeviceFillField = "username" | "password" | "code";

export interface DeviceLoginFill {
  text: "";
  hidden: boolean;
  origin: string;
  sites: string[];
  redactions: [];
  used: VaultItemUse | undefined;
  /** What the user's computer is asked to fill: the handle and which field, never a value. */
  deviceLogin: { handle: string; field: DeviceFillField };
}

/**
 * What a fill of a saved login does with a linked one (`resolveLoginFill`, once it has checked the
 * login's site and approval). `deviceId` is the user's own connected computer, given only by the
 * user's browser. A linked login is filled there by that computer alone; anywhere else, the bot's
 * hosted computer or another computer, it is refused. The user's browser fills nothing else.
 * Undefined when the caller goes on with an ordinary login.
 */
export function deviceLoginFill(input: {
  /** The stored value; undefined for the login this run's person typed and did not save. */
  sealed: string | undefined;
  deviceId: string | undefined;
  field: string;
  code: boolean;
  origin: string;
  sites: string[];
  used: VaultItemUse | undefined;
}): DeviceLoginFill | { error: string } | undefined {
  const link = input.sealed === undefined ? undefined : deviceLoginOf(input.sealed);
  if (!link) {
    if (input.deviceId === undefined) return undefined;
    return {
      error: input.code ? "Codes are unavailable here." : "Saved logins are unavailable here.",
    };
  }
  if (link.deviceId !== input.deviceId) return { error: DEVICE_LOGIN_ONLY };
  const [username, password] = DEFAULT_LOGIN_FIELD_LABELS;
  const field: DeviceFillField | undefined = input.code
    ? "code"
    : sameLoginFieldLabel(input.field, username)
      ? "username"
      : sameLoginFieldLabel(input.field, password)
        ? "password"
        : undefined;
  if (!field)
    return {
      error: `This login has no field named ${JSON.stringify(input.field)}. Its fields: ${DEFAULT_LOGIN_FIELD_LABELS.join(", ")}.`,
    };
  return {
    text: "",
    hidden: field !== "username",
    origin: input.origin,
    sites: input.sites,
    redactions: [],
    used: input.used,
    deviceLogin: { handle: link.handle, field },
  };
}

/** The owner's reveal of a linked login: there is no value on the server to show. */
export function rejectDeviceLoginReveal(plaintext: string): void {
  if (deviceLoginOf(plaintext))
    throw new ClientError("CONFLICT", "This login has no stored value.");
}

/**
 * Called in the write that overwrites a vault item with a value of its own (the owner saved a
 * username and password over it): when the item was a linked login it stops being one, so a later
 * removal of the link or of the computer cannot delete what the person typed. The old stored value
 * is read only to tell; one that cannot be read is no link.
 */
export async function unlinkDeviceLogin(
  tx: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<number> },
  id: string,
  previous: () => Promise<string>,
): Promise<void> {
  const link = await previous().then(deviceLoginOf, () => undefined);
  if (link) await tx.$executeRaw`DELETE FROM dozo_device_logins WHERE "credentialId" = ${id}`;
}
