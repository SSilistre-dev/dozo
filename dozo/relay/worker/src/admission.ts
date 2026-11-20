import type { RelayRegisterRequestSchema } from "@rakazo/contracts";
import type * as z from "zod";
import type { Env } from "./env.js";

/**
 * The one step that decides whether a registration may create a channel, after its body parsed.
 * False answers the same `404` as every other refusal. A deployment that ties channels to an
 * account swaps in a check of the request here; nothing else in the relay changes.
 */
export type Admission = (
  request: Request,
  body: z.infer<typeof RelayRegisterRequestSchema>,
  env: Env,
) => boolean | Promise<boolean>;

/** The default: anyone may register, as the protocol describes. */
export const openAdmission: Admission = () => true;
