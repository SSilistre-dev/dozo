import { z } from "zod";

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
