import { oc } from "@orpc/contract";
import * as z from "zod";

export const DOZO_ANNOUNCEMENT_MAX = 200;
export const DOZO_MAX_COMPUTERS_PER_USER_MAX = 1000;

/**
 * Control and format characters (line breaks, bidirectional overrides and isolates, zero-width
 * marks) and the line and paragraph separators: none belongs in a one-line notice, and a
 * bidirectional override would show readers a different text than the one written.
 */
const NOT_PLAIN_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** One short line of plain text; an empty one is no announcement. */
const AnnouncementInput = z
  .string()
  .trim()
  .max(DOZO_ANNOUNCEMENT_MAX)
  .refine((value) => !NOT_PLAIN_TEXT.test(value), "An announcement is one line of plain text");

/** The site settings an admin changes at run time, as the admin page shows them. */
export const DozoSiteSettingsSchema = z.object({
  /** What an admin set; null follows the environment. */
  signupsOpen: z.boolean().nullable(),
  /** 0 is no cap; null follows the environment. */
  maxComputersPerUser: z.number().int().min(0).nullable(),
  /** Empty when there is none. */
  announcementEn: z.string(),
  announcementTr: z.string(),
  /** What the server's environment says, which a null setting follows. */
  environment: z.object({
    signupsOpen: z.boolean(),
    maxComputersPerUser: z.number().int().min(0),
  }),
  /**
   * What the running computers may hold together, in GB, as the computer host reports it. Read
   * only: the host reads it from its own environment. Null when it reports none.
   */
  memoryBudgetGb: z.number().nullable(),
});
export type DozoSiteSettings = z.infer<typeof DozoSiteSettingsSchema>;

/** A field left out stays as it is; null returns a setting to the environment. */
export const DozoSiteSettingsChangeSchema = z
  .object({
    signupsOpen: z.boolean().nullable(),
    maxComputersPerUser: z.number().int().min(0).max(DOZO_MAX_COMPUTERS_PER_USER_MAX).nullable(),
    announcementEn: AnnouncementInput,
    announcementTr: AnnouncementInput,
  })
  .partial();
export type DozoSiteSettingsChange = z.infer<typeof DozoSiteSettingsChangeSchema>;

export const DozoAnnouncementSchema = z.object({
  en: z.string().nullable(),
  tr: z.string().nullable(),
});
export type DozoAnnouncement = z.infer<typeof DozoAnnouncementSchema>;

export const dozoSiteSettingsContract = {
  /** FORBIDDEN unless the caller is a deployment admin. Never carries a secret. */
  get: oc.output(DozoSiteSettingsSchema),
  /** FORBIDDEN unless the caller is a deployment admin. Each change is audited. */
  update: oc.input(DozoSiteSettingsChangeSchema).output(DozoSiteSettingsSchema),
  /** The announcement every signed-in person sees; null for a language without one. */
  announcement: oc.output(DozoAnnouncementSchema),
};
