import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/**
 * A personal access token for the bot API, as its owner sees it in settings: never the token
 * itself, only its last four characters. `botId` null means every bot in the Space.
 */
export const DozoAccessTokenSchema = z.object({
  id: Id,
  name: z.string(),
  botId: Id.nullable(),
  botName: z.string().nullable(),
  hint: z.string(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
});
export type DozoAccessToken = z.infer<typeof DozoAccessTokenSchema>;

export const DozoAccessTokenCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Absent: every bot the member can talk to in the Space. */
  botId: Id.optional(),
});
export type DozoAccessTokenCreateInput = z.infer<typeof DozoAccessTokenCreateInputSchema>;

/** The signed-in member's tokens in the current Space. A token can never call these. */
export const dozoAccessTokensContract = {
  list: oc.output(z.array(DozoAccessTokenSchema)),
  /** The token is in this answer only; it cannot be read again. */
  create: oc
    .input(DozoAccessTokenCreateInputSchema)
    .output(z.object({ token: z.string(), accessToken: DozoAccessTokenSchema })),
  revoke: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
};
