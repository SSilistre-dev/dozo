import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** Minutes past local midnight, in the account's timezone. */
const Minute = /* @__PURE__ */ z.number().int().min(0).max(1439);

/** What turning the daily digest on starts with: 8 in the morning. */
export const DOZO_DEFAULT_DIGEST_MINUTE = 8 * 60;

const DigestState = /* @__PURE__ */ z.object({
  /** Null when the digest is off. The minute is null once its routine runs on another schedule. */
  digest: z.object({ botId: Id, botName: z.string(), minute: Minute.nullable() }).nullable(),
});

export const dozoDailyDigestContract = /* @__PURE__ */ (() => ({
  get: oc.output(DigestState),
  /** Null turns the digest off. */
  set: oc
    .input(z.object({ digest: z.object({ botId: Id, minute: Minute }).nullable() }))
    .output(DigestState),
}))();
