import { oc } from "@orpc/contract";
import * as z from "zod";
import { IsoDate } from "./ids.js";

/**
 * How much of the caller's model input this period was read back from a provider's prompt cache.
 * Input counts every input token: uncached, read from the cache and written to it.
 */
export const DozoCacheSavingsSchema = z.object({
  /** The start of the period: the live subscription's billing period, else the UTC month. */
  since: IsoDate,
  inputTokens: z.number().int().positive(),
  cacheReadTokens: z.number().int().nonnegative(),
  /** cacheReadTokens as a whole percent of inputTokens. */
  cacheReadPercent: z.number().int().min(0).max(100),
});
export type DozoCacheSavings = z.infer<typeof DozoCacheSavingsSchema>;

export const dozoUsageContract = {
  /** The caller's own usage in the current Space; null when it has no input this period. */
  cacheSavings: oc.output(DozoCacheSavingsSchema.nullable()),
};
