import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** No link lives longer than this; its maker picks a shorter life or this one. */
export const DOZO_SHARE_LINK_MAX_DAYS = 30;
/** How many of a member's links the list returns, newest first. */
export const DOZO_SHARE_LINKS_LISTED = 200;

/** The web address a link opens: `<web origin>/s/<token>`, read signed out. */
export const DOZO_SHARE_LINK_WEB_PREFIX = "/s/";
/** Where the web page reads what a link shows, signed out. */
export const DOZO_SHARE_LINK_API_PREFIX = "/api/v1/dozo/shared/";

/** 32 random bytes as base64url. */
const DOZO_SHARE_TOKEN_LENGTH = 43;

/** Whether a string can be a link's token at all; anything else is refused before any lookup. */
export function looksLikeDozoShareToken(token: string): boolean {
  return token.length === DOZO_SHARE_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);
}

/** What a link shows ("replay", "stats", "bot"): a key of the server's kind map and the web's. */
export const DozoShareKindSchema = /* @__PURE__ */ (() =>
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))();

/** A link as its maker sees it: never the token, which is shown once, when the link is made. */
export const DozoShareLinkSchema = /* @__PURE__ */ (() =>
  z.object({
    id: Id,
    kind: DozoShareKindSchema,
    targetId: Id,
    createdAt: IsoDate,
    expiresAt: IsoDate,
    revokedAt: IsoDate.nullable(),
  }))();
export type DozoShareLink = z.infer<typeof DozoShareLinkSchema>;

/** What a signed-out reader gets for a live link; the payload's shape belongs to its kind. */
export const DozoSharedSchema = /* @__PURE__ */ (() =>
  z.object({ kind: DozoShareKindSchema, payload: z.unknown() }))();
export type DozoShared = z.infer<typeof DozoSharedSchema>;

/** Links the signed-in member makes, lists and revokes in the current Space. */
export const dozoShareLinksContract = /* @__PURE__ */ (() => ({
  /** Refused as not found when the kind is unknown or the member may not share the target. */
  create: oc
    .input(
      z.object({
        kind: DozoShareKindSchema,
        targetId: Id.max(200),
        days: z.number().int().min(1).max(DOZO_SHARE_LINK_MAX_DAYS),
      }),
    )
    .output(z.object({ link: DozoShareLinkSchema, url: z.string().url() })),
  list: oc.output(z.object({ links: z.array(DozoShareLinkSchema).max(DOZO_SHARE_LINKS_LISTED) })),
  /** Revoking a revoked link succeeds; another member's link is not found. */
  revoke: oc.input(z.object({ id: Id })).output(z.object({ revoked: z.literal(true) })),
}))();
