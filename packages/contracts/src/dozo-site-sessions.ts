import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/**
 * A site the bot's browser holds cookies for, by name and time only. Cookie values never leave
 * the bot's computer: this shape has no field that could carry one, and the server reads none.
 */
export const DozoSiteSessionSchema = z.object({
  /** The registrable domain, such as `example.com` or `alice.github.io`. */
  site: z.string(),
  /** When the oldest cookie the site still has was set; null until the browser has saved it. */
  since: z.string().nullable(),
  /** When the browser last sent one of its cookies; null until the browser has saved it. */
  lastUsedAt: z.string().nullable(),
});
export type DozoSiteSession = z.infer<typeof DozoSiteSessionSchema>;

export const DozoSiteSessionListSchema = z.object({ sites: z.array(DozoSiteSessionSchema) });
export type DozoSiteSessionList = z.infer<typeof DozoSiteSessionListSchema>;

/** An http(s) address without a user name or password, as the bot's browser may open it. */
export const DozoSignInUrl = z
  .string()
  .trim()
  .max(2048)
  .transform((value) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !!url.hostname;
  }, "Enter a web address");

const BotInput = z.object({ botId: Id });

export const dozoSiteSessionsContract = {
  /** Empty while the computer is not running or cannot tell. */
  list: oc.input(BotInput).output(DozoSiteSessionListSchema),
  /** Removes one site's cookies and storage from the bot's browser, or every site's without one. */
  signOut: oc
    .input(BotInput.extend({ site: z.string().min(1).max(253).optional() }))
    .output(z.object({ ok: z.literal(true) })),
  /** Takes control for the caller and opens the address in the bot's browser. */
  signIn: oc
    .input(BotInput.extend({ url: DozoSignInUrl }))
    .output(z.object({ leaseId: z.string(), expiresAt: z.string() })),
};
