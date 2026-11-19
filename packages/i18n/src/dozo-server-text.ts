import { i18n } from "@lingui/core";
import { isModelRequiredSendError } from "@rakazo/core";

/** The server's refusal when an organization's computer hours are spent (contracts' constant). */
export const NO_COMPUTER_HOURS = "No computer hours left.";

/**
 * Refusals people often see, by the server's fixed English sentence. Each is its own catalog id;
 * the Turkish is in the fork's catalog block, and a test holds every one to having it.
 */
export const SERVER_SENTENCES: ReadonlySet<string> = new Set([
  "Connect a model to start a run.",
  "Choose a model",
  "Choose a model that can see images",
  "Connect that model provider first",
  "Unknown model for that provider",
  "Unknown model for that connection",
  "Enter an API key.",
  "Model credentials changed; retry.",
  "Model preferences changed; retry.",
  "Credential was not saved",
  "Stop the bot first",
  "Start the computer first.",
  "Release the computer first",
  "Take control first.",
  "Computer is busy",
  "Someone else is using this computer",
  "The computer is working for someone else",
  "Could not take control of the computer",
  "The computer did not start. Try again.",
  "Too many computer requests. Try again later.",
  "Computers are unavailable right now. Try again later.",
  "This computer's system is damaged. Recover the computer to rebuild it.",
  "Computer requires recovery after an unconfirmed stop. Recover the computer to rebuild it.",
  "The page browser could not accept this request, so nothing was done.",
  "The bot is no longer waiting",
  "The bot is waiting for someone else",
  "Space not found",
  "Space name must be readable and between 1 and 60 characters",
  "The default space cannot be deleted",
  "The last remaining space cannot be deleted",
  "Only the space owner can delete it",
  "Only the space owner can rename it",
  "Only the space owner can do that",
  "Space deletion is already in progress",
  "This invite link is invalid or has expired",
  "Too many open invite links; wait for some to be used or expire",
  "Member not found",
  "The space owner cannot be removed",
  "The space owner cannot leave; delete the space instead",
  "Your only organization cannot be deleted",
  "An organization with other members cannot be deleted",
  "Organization is being deleted",
  "Admins only",
  "Already subscribed",
  "Manage your existing subscription in Billing",
  "Resume the subscription in billing",
  "Billing is busy; try again shortly",
  "No own-key plan to change",
  "Pick a model for this routine first",
  "Enter a valid cron expression.",
  "Pick a time within the next year",
  "file is too large",
  "This plugin is already installed",
  "Plugin changed. Reload and try again",
  "Connect a voice provider first.",
  "Choose a space",
  "Sign-in has not finished yet.",
  "This bot already has an address.",
  "Choose an email address for this bot first.",
  "A skill with that name already exists.",
]);

function messageOf(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const message =
    error !== null && typeof error === "object" ? Reflect.get(error, "message") : undefined;
  return typeof message === "string" ? message : undefined;
}

/** A refusal people often see, in the UI's language; null for any other text. */
export function knownServerText(error: unknown): string | null {
  const message = messageOf(error)?.trim();
  return message && SERVER_SENTENCES.has(message) ? i18n._({ id: message, message }) : null;
}

/**
 * What a failure says once the client chose `text` for it. A known refusal reads in the UI's
 * language. Any other English the server wrote (the failure carries an HTTP status and `text` is
 * its message) becomes `fallback` where the UI is not English. Two refusals stay as they are,
 * because screens recognise them afterwards and word them themselves: no model connected, and no
 * computer hours left.
 */
export function serverErrorText(error: unknown, text: string, fallback: string): string {
  const message = messageOf(error)?.trim();
  if (isModelRequiredSendError(error) || message?.startsWith(NO_COMPUTER_HOURS)) return text;
  const known = knownServerText(error);
  if (known) return known;
  const status =
    error !== null && typeof error === "object" ? Reflect.get(error, "status") : undefined;
  const english = !i18n.locale || i18n.locale.startsWith("en");
  return typeof status === "number" && !english && text === message ? fallback : text;
}
