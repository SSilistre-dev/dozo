import { oc } from "@orpc/contract";
import * as z from "zod";

export const DozoCallCheckSchema = /* @__PURE__ */ (() =>
  z.object({
    /** False where nothing is asked (a hosted deployment): the call starts as it always did. */
    checked: z.boolean(),
    /** What did not answer: the speech server, or the bot's model. Null when the call may start. */
    refusal: z.enum(["speech", "model"]).nullable(),
    /** The speech server hears the caller, so the page need not use the browser's own recognizer. */
    serverDictation: z.boolean(),
  }))();
export type DozoCallCheck = z.infer<typeof DozoCallCheckSchema>;

export const dozoCallPreflightContract = /* @__PURE__ */ (() => ({
  /** Asks the places a call needs, without a model call, before the call rings. */
  check: oc.input(z.object({ botId: z.string() })).output(DozoCallCheckSchema),
}))();
