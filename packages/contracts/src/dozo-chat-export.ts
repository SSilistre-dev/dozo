import { oc } from "@orpc/contract";
import * as z from "zod";
import { dozoThreadTargetCheck } from "./dozo-bot-chats.js";
import { Id, IsoDate } from "./ids.js";

export const DozoChatExportInputSchema = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
    /** A bot's extra chat: its bot and the chat, in place of botId. */
    chatBotId: Id.optional(),
    chatId: Id.optional(),
    /** Only messages sent at or after this time; absent exports the whole chat. */
    since: IsoDate.optional(),
    /** The reader's IANA time zone for message times; absent or unknown means UTC. */
    timeZone: z.string().max(64).optional(),
  })
  .superRefine(dozoThreadTargetCheck);
export type DozoChatExportInput = z.infer<typeof DozoChatExportInputSchema>;

export const DozoChatExportSchema = /* @__PURE__ */ z.object({
  markdown: z.string(),
  /** The size limit was reached: the newest messages are in, earlier ones are left out. */
  truncated: z.boolean(),
});
export type DozoChatExport = z.infer<typeof DozoChatExportSchema>;

export const dozoChatExportContract = /* @__PURE__ */ (() => ({
  /** One chat as Markdown, as its transcript shows it to the caller. */
  markdown: oc.input(DozoChatExportInputSchema).output(DozoChatExportSchema),
}))();

/** How far back an export reaches: the whole chat, today, or the last 7 or 30 days. */
export type ChatExportRange = "all" | "today" | "week" | "month";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first moment a range covers, in the reader's own day; nothing for the whole chat. */
export function chatExportSince(range: ChatExportRange, now: Date): string | undefined {
  if (range === "all") return undefined;
  if (range === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
  }
  return new Date(now.getTime() - (range === "week" ? 7 : 30) * DAY_MS).toISOString();
}
