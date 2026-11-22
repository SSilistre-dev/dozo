import { oc } from "@orpc/contract";
import * as z from "zod";
import { IsoDate } from "./ids.js";

/**
 * How much of the caller's model input this period was read back from a provider's prompt cache.
 * Input counts every input token: uncached, read from the cache and written to it. Records
 * without a measured input or cache read count are left out.
 */
export const DozoCacheSavingsSchema = z.object({
  /** The start of the period: the current month of the live billing period, else the UTC month. */
  since: IsoDate,
  inputTokens: z.number().int().positive(),
  cacheReadTokens: z.number().int().nonnegative(),
  /** cacheReadTokens as a whole percent of inputTokens. */
  cacheReadPercent: z.number().int().min(0).max(100),
});
export type DozoCacheSavings = z.infer<typeof DozoCacheSavingsSchema>;

/**
 * What the Usage table groups spend by. `day` is the caller's last 30 days, one row per day in
 * the account's time zone; `person` is every member of the Space and only the owner may ask.
 */
export const DozoUsageGroupingSchema = z.enum(["model", "bot", "routine", "day", "person"]);
export type DozoUsageGrouping = z.infer<typeof DozoUsageGroupingSchema>;

/**
 * One group of the caller's usage. `state` says what `name` is: a bot or routine that exists,
 * a deleted bot (its name kept), no bot or routine at all, or one the records cannot tell any
 * more (a routine since deleted, a run that is gone). Totals are null when a record in the group
 * lacks the count, so they never understate spend.
 */
export const DozoUsageGroupSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  /** The provider of a model, the bot of a routine, the email of a person; null otherwise. */
  detail: z.string().nullable(),
  state: z.enum(["live", "deleted", "none", "unknown"]),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export type DozoUsageGroup = z.infer<typeof DozoUsageGroupSchema>;

const GroupingInput = z.object({ by: DozoUsageGroupingSchema });

export const dozoUsageContract = /* @__PURE__ */ (() => ({
  /** The caller's own usage in the current Space; null when it has no input this period. */
  cacheSavings: oc.output(DozoCacheSavingsSchema.nullable()),
  /** The caller's own usage in the current Space, as the Usage summary counts it, grouped. */
  breakdown: oc.input(GroupingInput).output(z.array(DozoUsageGroupSchema)),
  /** Whether the caller may group by person: the owner of a Space with other members. */
  scope: oc.output(z.object({ person: z.boolean() })),
  /** The same groups as a CSV file, rendered on the server. */
  csv: oc.input(GroupingInput).output(z.object({ csv: z.string() })),
}))();
