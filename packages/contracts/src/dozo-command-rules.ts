import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A command the signed-in member always allows one bot to run on their own computer, in the
 * current Space: its words in order and the folder it runs in ('' for the home folder).
 */
export const DozoCommandRuleSchema = z.object({
  id: z.string(),
  botId: z.string(),
  botName: z.string(),
  words: z.array(z.string()),
  cwd: z.string(),
});
export type DozoCommandRule = z.infer<typeof DozoCommandRuleSchema>;

export const dozoCommandRulesContract = {
  list: oc.output(z.array(DozoCommandRuleSchema)),
  remove: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ ok: z.literal(true) })),
};
