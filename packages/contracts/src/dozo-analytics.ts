import { oc } from "@orpc/contract";
import { z } from "zod";
import { ByokIntervalSchema, ByokTierSchema } from "./billing.js";
import { PLAN_LIMIT_CODES } from "./dozo-plan-limits.js";
import { IsoDate } from "./ids.js";

/**
 * The fork's product events, added to `AnalyticsEvent`. Like every event there, only fixed
 * values: never an address, a name or what a message says. Nothing is sent unless analytics is
 * configured.
 */

/** The limits a member can lift by upgrading; a busy host or an unsold plan is not one. */
export const DOZO_PLAN_LIMIT_KINDS = [
  "computer_hours",
  PLAN_LIMIT_CODES.sharedSpaceFull,
  PLAN_LIMIT_CODES.computerLimit,
  PLAN_LIMIT_CODES.spaceLimit,
] as const;
export const DozoPlanLimitKindSchema = z.enum(DOZO_PLAN_LIMIT_KINDS);

/** Where the paid plans were shown from: required to go on, opened in the app, or a landing pick. */
export const DozoUpgradeSourceSchema = z.enum(["paywall", "app", "landing"]);

const planLimitHit = z
  .object({ name: z.literal("plan_limit_hit"), kind: DozoPlanLimitKindSchema })
  .strict();
const upgradeViewed = z
  .object({ name: z.literal("upgrade_viewed"), source: DozoUpgradeSourceSchema })
  .strict();
// A paid plan picked on the landing page, claimed by the account that signed up with it.
const planIntent = z
  .object({ name: z.literal("plan_intent"), plan: ByokTierSchema, period: ByokIntervalSchema })
  .strict();

/** What the apps report themselves; the server adds who, and checks when. */
export const DozoClientEventSchema = z.discriminatedUnion("name", [
  // When this tab opened the sign-up form, before the account it made.
  z.object({ name: z.literal("signup_started"), startedAt: IsoDate }).strict(),
  planLimitHit,
  upgradeViewed,
  planIntent,
]);
export type DozoClientEvent = z.infer<typeof DozoClientEventSchema>;

export const DOZO_ANALYTICS_EVENTS = [
  z.object({ name: z.literal("signup_started") }).strict(),
  z.object({ name: z.literal("first_bot_created") }).strict(),
  // The member's first message; `message_sent` still counts every one.
  z.object({ name: z.literal("first_message_sent") }).strict(),
  planLimitHit,
  upgradeViewed,
  planIntent,
  z.object({ name: z.literal("payment_failed") }).strict(),
  // Set to end, at the period's end or at once.
  z.object({ name: z.literal("subscription_canceled"), atPeriodEnd: z.boolean() }).strict(),
  z.object({ name: z.literal("refund_issued") }).strict(),
] as const;

/** Any signed-in member may report; nothing is sent unless analytics is configured. */
export const dozoEventsContract = {
  track: oc.input(DozoClientEventSchema).output(z.object({ ok: z.literal(true) })),
};
