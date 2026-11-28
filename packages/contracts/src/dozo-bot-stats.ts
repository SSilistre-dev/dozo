import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** Share-link kind of a bot's stats card: a key of the server's kind map and the web's. */
export const DOZO_STATS_SHARE_KIND = "stats";

const Count = /* @__PURE__ */ (() => z.number().int().min(0))();

/**
 * What a bot has done for its owner, counted from rows that already exist: finished turns they
 * asked for, finished routine runs (never also a task), saved skills, and UTC days with finished
 * work. Nothing here is spend or text.
 */
export const DozoBotStatsSchema = /* @__PURE__ */ (() =>
  z.object({
    tasksFinished: Count,
    routineRuns: Count,
    skillsLearned: Count,
    /** Distinct UTC days on which a finished run of the owner's own work happened. */
    daysActive: Count,
    /** The bot's history ran past what one read looks at: every number is then "at least". */
    more: z.boolean(),
  }))();
export type DozoBotStats = z.infer<typeof DozoBotStatsSchema>;

/** The whole public payload of a stats card; a reader sees exactly this. */
export const DozoStatsCardSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string(),
    character: z.string(),
    color: z.string().nullable(),
    stats: DozoBotStatsSchema,
  }))();
export type DozoStatsCard = z.infer<typeof DozoStatsCardSchema>;

export const dozoBotStatsContract = /* @__PURE__ */ (() => ({
  /** The bot's numbers; only the bot's owner may read them, anyone else gets not found. */
  get: oc.input(z.object({ botId: Id })).output(DozoBotStatsSchema),
}))();

/** A number as shown: "1,200", or "1,200+" when the read stopped short of the bot's whole history. */
export function formatDozoStat(value: number, more: boolean): string {
  return `${value.toLocaleString()}${more ? "+" : ""}`;
}
