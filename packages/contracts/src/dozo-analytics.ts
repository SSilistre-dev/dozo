import { oc } from "@orpc/contract";
import { z } from "zod";
import { IsoDate } from "./ids.js";

/**
 * The fork's product events, added to `AnalyticsEvent`. Like every event there, only fixed
 * values: never an address, a name or what a message says. Nothing is sent unless analytics is
 * configured.
 */

/** What the apps report themselves; the server adds who, and checks when. */
export const DozoClientEventSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion("name", [
    // When this tab opened the sign-up form, before the account it made.
    z.object({ name: z.literal("signup_started"), startedAt: IsoDate }).strict(),
  ]))();
export type DozoClientEvent = z.infer<typeof DozoClientEventSchema>;

export const DOZO_ANALYTICS_EVENTS = [
  z.object({ name: z.literal("signup_started") }).strict(),
  z.object({ name: z.literal("first_bot_created") }).strict(),
  // The member's first message; `message_sent` still counts every one.
  z.object({ name: z.literal("first_message_sent") }).strict(),
] as const;

/** Any signed-in member may report; nothing is sent unless analytics is configured. */
export const dozoEventsContract = /* @__PURE__ */ (() => ({
  track: oc.input(DozoClientEventSchema).output(z.object({ ok: z.literal(true) })),
}))();
