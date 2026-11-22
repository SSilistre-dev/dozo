import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { BROWSER_SIGN_IN_TOOL } from "./dozo-browser-sign-in.tool-definition.js";
import { isPhonePlatform } from "./dozo-phone-protocol.js";
import type { UserDevice } from "./user-device-protocol.js";

/**
 * Sent by a paired computer when it connects: what it can do, comma-separated. A computer that
 * sends nothing (the desktop app before this header) runs commands only.
 */
export const DEVICE_CAPABILITIES_HEADER = "x-dozo-device-capabilities";

/** What a paired computer or phone can declare. Anything else it sends is ignored. */
export const DEVICE_CAPABILITIES = [
  "shell",
  "screen",
  "browser",
  "calendar",
  "contacts",
  "location",
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];
/** What a phone may offer: nothing a computer does, whatever it declares. */
const PHONE_CAPABILITIES: readonly DeviceCapability[] = ["calendar", "contacts", "location"];
const COMPUTER_CAPABILITIES: readonly DeviceCapability[] = ["shell", "screen", "browser"];

/** A connected computer, with what it declared; undefined when it did not come through the hub. */
export type DeclaredUserDevice = UserDevice & { capabilities?: readonly DeviceCapability[] };

/** The declared capabilities in a header value, known ones only, each once; null when absent. */
export function parseDeviceCapabilities(
  header: string | string[] | undefined,
): DeviceCapability[] | null {
  if (header === undefined) return null;
  const words = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((word) => word.trim().toLowerCase());
  return DEVICE_CAPABILITIES.filter((capability) => words.includes(capability));
}

/** Saves what a computer declared on this connection; null (it declared nothing) forgets it. */
export async function recordDeviceCapabilities(
  prisma: PrismaClient,
  deviceId: string,
  capabilities: readonly DeviceCapability[] | null,
): Promise<void> {
  await runAsSystem("record a user device's capabilities", () =>
    capabilities
      ? prisma.$executeRaw`
          INSERT INTO dozo_device_capabilities ("deviceId", capabilities)
          VALUES (${deviceId}, ${[...capabilities]}::text[])
          ON CONFLICT ("deviceId") DO UPDATE SET capabilities = EXCLUDED.capabilities`
      : prisma.$executeRaw`DELETE FROM dozo_device_capabilities WHERE "deviceId" = ${deviceId}`,
  );
}

/**
 * What a device declared when it last connected, of what its kind may offer. A computer that
 * declared nothing runs commands only; a phone that declared nothing offers nothing.
 */
export async function readDeviceCapabilities(
  prisma: PrismaClient,
  deviceId: string,
  platform = "",
): Promise<DeviceCapability[]> {
  const rows = await runAsSystem(
    "read a user device's capabilities",
    () =>
      prisma.$queryRaw<{ capabilities: string[] }[]>`
      SELECT capabilities FROM dozo_device_capabilities WHERE "deviceId" = ${deviceId}`,
  );
  const declared = rows[0]?.capabilities;
  const phone = isPhonePlatform(platform);
  if (!declared) return phone ? [] : ["shell"];
  const allowed = phone ? PHONE_CAPABILITIES : COMPUTER_CAPABILITIES;
  return allowed.filter((value) => declared.includes(value));
}

/**
 * Which of the user's own computer tools a run is offered on this computer. A computer from the
 * hub is held to what it declared. One that did not come through it (the desktop server's own
 * computer, a test emulator) declares nothing: commands as upstream has them, and no screen, which
 * no app the fork ships can answer.
 */
export function deviceOffers(device: DeclaredUserDevice): {
  shell: boolean;
  screen: boolean;
  browser: boolean;
} {
  // A phone is not a computer: none of the computer's tools go to it.
  if (isPhonePlatform(device.platform)) return { shell: false, screen: false, browser: false };
  if (!device.capabilities) return { shell: !device.screenOnly, screen: false, browser: false };
  return {
    shell: device.capabilities.includes("shell"),
    screen: device.capabilities.includes("screen"),
    // A browser of the bot's own there (dozo-user-browser.ts).
    browser: device.capabilities.includes("browser"),
  };
}

/**
 * When the computer has a browser, the run is offered the page tools for it and the sign-in: they
 * leave the run's turned-off tools (where a run without a computer of its own, or every run for the
 * sign-in, put them), unless the bot itself turned them off.
 */
export function offerUserBrowser(
  disabled: Set<string>,
  botDisabled: readonly string[] | null | undefined,
): boolean {
  for (const name of [...USER_BROWSER_TOOLS, BROWSER_SIGN_IN_TOOL])
    if (!botDisabled?.includes(name)) disabled.delete(name);
  return USER_BROWSER_TOOLS.some((name) => !disabled.has(name));
}

const USER_BROWSER_TOOLS = ["browser_navigate", "browser_snapshot", "browser_act"];
