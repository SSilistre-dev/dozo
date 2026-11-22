import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/**
 * A personal access token for the bot API, as its owner sees it in settings: never the token
 * itself, only its last four characters. `botId` null means every bot in the Space.
 */
export const DozoAccessTokenSchema = /* @__PURE__ */ z.object({
  id: Id,
  name: z.string(),
  botId: Id.nullable(),
  botName: z.string().nullable(),
  hint: z.string(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
  /** Null for a token made to never expire. */
  expiresAt: IsoDate.nullable(),
});
export type DozoAccessToken = z.infer<typeof DozoAccessTokenSchema>;

/** How long a new token lasts unless its maker chooses never. */
export const DOZO_ACCESS_TOKEN_DAYS = 90;

export const DozoAccessTokenCreateInputSchema = /* @__PURE__ */ z.object({
  name: z.string().trim().min(1).max(60),
  /** Absent: every bot the member can talk to in the Space. */
  botId: Id.optional(),
  /** Days until it stops working by itself; null never. */
  expiresInDays: z.union([z.literal(90), z.null()]).default(DOZO_ACCESS_TOKEN_DAYS),
});
export type DozoAccessTokenCreateInput = z.infer<typeof DozoAccessTokenCreateInputSchema>;

/** The signed-in member's tokens in the current Space. A token can never call these. */
export const dozoAccessTokensContract = /* @__PURE__ */ (() => ({
  list: oc.output(z.array(DozoAccessTokenSchema)),
  /** The token is in this answer only; it cannot be read again. */
  create: oc
    .input(DozoAccessTokenCreateInputSchema)
    .output(z.object({ token: z.string(), accessToken: DozoAccessTokenSchema })),
  revoke: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  /** Whether a bot is marked by text sent with a token, so its runs ask before acting. */
  botMark: oc.input(z.object({ botId: Id })).output(z.object({ marked: z.boolean() })),
  /**
   * The owner trusts a marked bot again, after confirming it is them: earlier token messages and
   * marks no longer make it ask. Never reachable with a token.
   */
  trustBot: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
}))();
