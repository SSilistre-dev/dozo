import { z } from "zod";
import { DEVICE_HANDLE } from "./dozo-device-login.js";

/**
 * One DevTools command for the bot's own browser on the user's computer. The desktop app passes
 * on only its allowlist (`dozo/desktop/src/browser.rs`) and answers with the command's result and
 * the page's events since its last answer.
 */
export const pageBrowserRequest = z.object({
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
  /** The bot's name, which the app shows beside its browser so the person can clear it. */
  botName: z.string().max(256).optional(),
  method: z.literal("pageBrowser"),
  command: z.object({
    method: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * The person signs in to a site in the bot's own browser: the desktop app opens the site's home
 * page and passes nothing on until the person says they are done; it answers `{ signedIn }`.
 */
export const pageBrowserSignInRequest = z.object({
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
  botName: z.string().max(256).optional(),
  method: z.literal("pageBrowserSignIn"),
  site: z.string().min(1).max(253),
});

/**
 * Whether the person cleared the bot's browser on that computer (its profile and sign-ins are
 * gone): the server then forgets what the bot was allowed there, and asks again with `forgotten`
 * once it has, which alone lets the app start that browser again. Answers `{ cleared }`.
 */
export const pageBrowserClearedRequest = z.object({
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
  method: z.literal("pageBrowserCleared"),
  forgotten: z.literal(true).optional(),
});

/** An https origin as a URL gives it: no path, no query, no default port. */
function isHttpsOrigin(value: string): boolean {
  return (
    URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).origin === value
  );
}

/**
 * Fill one field of a page in the bot's own browser from the password manager on the computer: the
 * app checks the site and the field itself, reads the value there with the user's approval and
 * writes it straight into the page. The value never travels, in either direction; this names the
 * node (its backend node id), the site the user approved and the link's handle. Answers
 * `{ filled: true }`, or an error code (`passwords-*`) that dozo-device-browser.ts words.
 */
export const pageBrowserFillLoginRequest = z.object({
  botId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).optional(),
  method: z.literal("pageBrowserFillLogin"),
  ref: z.number().int().min(0).max(2_147_483_647),
  origin: z.string().max(300).refine(isHttpsOrigin),
  handle: z.string().regex(DEVICE_HANDLE),
  field: z.enum(["username", "password", "code"]),
});
