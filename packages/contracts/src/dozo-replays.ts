import { oc } from "@orpc/contract";
import * as z from "zod";
import { DOZO_SHARE_LINK_MAX_DAYS, DozoShareLinkSchema } from "./dozo-share-links.js";
import { Id } from "./ids.js";

/** The share link kind a replay is published under. */
export const DOZO_REPLAY_KIND = "replay";
/** A new replay link lives this long. */
export const DOZO_REPLAY_DEFAULT_DAYS = 7;
/** The most steps one replay shows. */
export const DOZO_REPLAY_STEPS_MAX = 500;

/** What a step shows anyone holding the link: the kind of action, and the site by host name. */
const ReplayLine = z.string().max(200);

/** One step as its owner reviews it before publishing. */
export const DozoReplayDraftStepSchema = /* @__PURE__ */ (() =>
  z.object({
    line: ReplayLine,
    /** The screenshot kept for this step, as a data URL; null when it has none. */
    frame: z.string().nullable(),
    /** The step, or one before it, touched a sign-in, a saved value, a payment or a signed-in site. */
    sensitive: z.boolean(),
  }))();
export type DozoReplayDraftStep = z.infer<typeof DozoReplayDraftStepSchema>;

/**
 * What a replay link shows, signed out: each kept step's line, and the number of its screenshot
 * under the link (`<link's read address>/frames/<n>`), or null.
 */
export const DozoReplayPayloadSchema = /* @__PURE__ */ (() =>
  z.object({
    steps: z
      .array(z.object({ line: ReplayLine, frame: z.number().int().nonnegative().nullable() }))
      .max(DOZO_REPLAY_STEPS_MAX),
  }))();
export type DozoReplayPayload = z.infer<typeof DozoReplayPayloadSchema>;

const ReplayMessage = /* @__PURE__ */ (() => z.object({ messageId: Id }))();
const StepPositions = /* @__PURE__ */ (() =>
  z.array(z.number().int().nonnegative()).max(DOZO_REPLAY_STEPS_MAX).default([]))();

/**
 * A bot's owner publishes one finished reply of their own one-to-one chat with it. Anything else
 * (another member's bot, a group, a messaging app's chat, a reply without steps) is not found.
 */
export const dozoReplaysContract = /* @__PURE__ */ (() => ({
  /** Every step and screenshot that could be published, and the reply's live links. */
  preview: oc.input(ReplayMessage).output(
    z.object({
      steps: z.array(DozoReplayDraftStepSchema).max(DOZO_REPLAY_STEPS_MAX),
      links: z.array(DozoShareLinkSchema),
    }),
  ),
  /**
   * Publishes the reply's steps but those in `omit`, with the screenshots of the steps in
   * `frames` only (positions in the preview), as a new link.
   */
  publish: oc
    .input(
      ReplayMessage.extend({
        omit: StepPositions,
        frames: StepPositions,
        days: z.number().int().min(1).max(DOZO_SHARE_LINK_MAX_DAYS).default(DOZO_REPLAY_DEFAULT_DAYS),
      }),
    )
    .output(z.object({ link: DozoShareLinkSchema, url: z.string().url() })),
}))();
