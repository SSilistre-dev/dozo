import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** Most calls one bot makes to its person in any 24 hours when no one asked for them. */
export const DOZO_BOT_CALLS_PER_DAY = 3;

/**
 * Whether the person lets this bot ring them from a routine. `available` is false where calls
 * cannot happen: the server has them off, no voice provider is connected, or the bot is not the
 * caller's own. The setting is then neither shown nor changed.
 */
export const DozoBotCallsSchema = /* @__PURE__ */ (() =>
  z.object({ allowed: z.boolean(), available: z.boolean() }))();
export type DozoBotCalls = z.infer<typeof DozoBotCallsSchema>;

export const dozoBotCallsContract = /* @__PURE__ */ (() => ({
  get: oc.input(z.object({ botId: Id })).output(DozoBotCallsSchema),
  /** Refused as a conflict for anyone but the bot's own person. */
  set: oc.input(z.object({ botId: Id, allowed: z.boolean() })).output(DozoBotCallsSchema),
}))();
