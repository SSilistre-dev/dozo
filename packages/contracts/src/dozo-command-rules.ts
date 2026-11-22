import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * What a command rule does: `allow` runs exactly its words, `allow_prefix` its words followed by
 * other words that are not options, `block` refuses any command containing them, in every mode.
 */
export const DozoCommandRuleEffectSchema = z.enum(["allow", "allow_prefix", "block"]);

/**
 * A command rule of the signed-in member for one bot, in the current Space: its words in order, the
 * folder it runs in ('' for the home folder), what it does, and the computer it was saved on
 * (`user`: the member's own, `hosted`: the bot's).
 */
export const DozoCommandRuleSchema = z.object({
  id: z.string(),
  botId: z.string(),
  botName: z.string(),
  words: z.array(z.string()),
  cwd: z.string(),
  effect: DozoCommandRuleEffectSchema,
  computer: z.enum(["user", "hosted"]),
});
export type DozoCommandRule = z.infer<typeof DozoCommandRuleSchema>;

/**
 * Whether commands that change something on the bot's computer ask the member first. Null when the
 * Space has no computer of the bot's, so there is nothing to ask about.
 */
const HostedAsks = z.object({ hostedAsks: z.boolean().nullable() });

export const dozoCommandRulesContract = /* @__PURE__ */ (() => ({
  list: oc.output(z.array(DozoCommandRuleSchema)),
  update: oc
    .input(z.object({ id: z.string().min(1), effect: DozoCommandRuleEffectSchema }))
    .output(z.object({ ok: z.literal(true) })),
  remove: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ ok: z.literal(true) })),
  getHostedAsks: oc.output(HostedAsks),
  setHostedAsks: oc.input(z.object({ hostedAsks: z.boolean() })).output(HostedAsks),
}))();
