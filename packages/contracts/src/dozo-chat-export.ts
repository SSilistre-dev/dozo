import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const DozoChatExportInputSchema = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
    /** Only messages sent at or after this time; absent exports the whole chat. */
    since: IsoDate.optional(),
    /** The reader's IANA time zone for message times; absent or unknown means UTC. */
    timeZone: z.string().max(64).optional(),
  })
  .refine((input) => Boolean(input.botId) !== Boolean(input.groupId), {
    message: "Provide exactly one of botId or groupId",
    path: ["botId"],
  });
export type DozoChatExportInput = z.infer<typeof DozoChatExportInputSchema>;

export const DozoChatExportSchema = z.object({
  markdown: z.string(),
  /** The size limit was reached: the newest messages are in, earlier ones are left out. */
  truncated: z.boolean(),
});
export type DozoChatExport = z.infer<typeof DozoChatExportSchema>;

export const dozoChatExportContract = {
  /** One chat as Markdown, as its transcript shows it to the caller. */
  markdown: oc.input(DozoChatExportInputSchema).output(DozoChatExportSchema),
};
