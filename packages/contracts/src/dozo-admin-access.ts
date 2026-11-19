import { oc } from "@orpc/contract";
import * as z from "zod";
import { AccessGrantInputSchema } from "./domain.js";
import { Id } from "./ids.js";

/**
 * Changing and deleting free-access grants that no account has received yet. Refused with
 * FORBIDDEN unless the caller is a deployment admin, and NOT_FOUND while the deployment does not
 * bill, as upstream's grant procedures are.
 */
export const dozoAdminAccessContract = {
  /** A pending grant only: CONFLICT once an account received it or it was revoked. */
  update: oc
    .input(z.object({ id: Id, grant: AccessGrantInputSchema }))
    .output(z.object({ ok: z.literal(true) })),
  /** A pending or revoked grant: CONFLICT once an account received it, which it keeps. */
  delete: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
};
