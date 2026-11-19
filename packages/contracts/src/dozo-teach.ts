import { oc } from "@orpc/contract";
import * as z from "zod";
import { SkillPlaybookSchema, TaughtSkillSchema } from "./domain.js";
import { Id } from "./ids.js";

/** A value typed while teaching, as its placeholder in the steps names it (`{{value N}}`). */
const Placeholder = z.string().regex(/^\{\{value \d+\}\}$/);

/**
 * What becomes of one typed value: an input asked for on each run, an input typed from a saved
 * login (hidden), kept as typed in the steps, or dropped.
 */
export const DozoTeachValueDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("variable"), name: z.string().min(1).max(80) }),
  z.object({ action: z.literal("hidden"), name: z.string().min(1).max(80) }),
  z.object({ action: z.literal("fixed") }),
  z.object({ action: z.literal("remove") }),
]);
export type DozoTeachValueDecision = z.infer<typeof DozoTeachValueDecisionSchema>;

export const DozoTeachValueSchema = z.object({
  placeholder: Placeholder,
  /** Null for protected input, whose text is never stored, and for text that cannot be rebuilt. */
  text: z.string().nullable(),
  /** Typed as protected input: hidden by default, never kept as text. */
  secret: z.boolean(),
  /** A name the model suggested for it, when one was made. */
  suggestion: z.object({ name: z.string() }).optional(),
});
export type DozoTeachValue = z.infer<typeof DozoTeachValueSchema>;

/**
 * What one recorded click hit, kept in the recording beside its events: the window it was in
 * and, until the recording is drafted, a small WebP of the screen around it (base64).
 * `eventIndex` is the click's event.
 */
export const DozoTeachStoredTargetSchema = z.object({
  eventIndex: z.number().int().nonnegative(),
  window: z.string().optional(),
  image: z.string().optional(),
});
export type DozoTeachStoredTarget = z.infer<typeof DozoTeachStoredTargetSchema>;

/** A recorded click as the teacher reviews it: the step it became, and what it hit. */
export const DozoTeachTargetSchema = z.object({
  id: z.string(),
  /** Index of its click step in the draft's steps. */
  step: z.number().int().nonnegative(),
  window: z.string().optional(),
  /** A data URL. */
  image: z.string().optional(),
});
export type DozoTeachTarget = z.infer<typeof DozoTeachTargetSchema>;

/** A recorded click's id, as the review gives it. */
const TargetId = z.string().max(20);

/**
 * What a click hit, as the teacher kept it from the model's suggestion: plain text on one line,
 * with no input braces or quotes, so it can be quoted in a step as it is.
 */
export const DozoTeachLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^{}"\p{Cc}]+$/u);

const DraftInput = z.object({
  skillId: Id,
  name: z.string().max(200).optional(),
  playbook: SkillPlaybookSchema,
  decisions: z.record(Placeholder, DozoTeachValueDecisionSchema).default({}),
  /** Clicks whose picture the teacher removed: their steps keep only the coordinate. */
  removedTargets: z.array(TargetId).max(1_000).default([]),
  /**
   * The labels the teacher saw and kept, by click id; absent, no step says what was clicked
   * beyond its window. Only a click whose picture is still kept may have one.
   */
  labels: z.record(TargetId, DozoTeachLabelSchema).default({}),
});

export const dozoTeachContract = {
  /** The values typed and the clicks made while teaching; only the teacher gets them. */
  review: oc.input(z.object({ skillId: Id })).output(
    z.object({
      values: z.array(DozoTeachValueSchema),
      targets: z.array(DozoTeachTargetSchema),
    }),
  ),
  /** Saves the draft with the decisions applied and forgets what was typed, at once. */
  save: oc.input(DraftInput).output(TaughtSkillSchema),
  /**
   * Sends the draft's kept click pictures to the bot's model and returns what it says each one
   * hit, for the teacher to see and edit; nothing is kept. Only ever called when the teacher
   * chooses to; clicks before a value `decisions` hide are not sent.
   */
  labelTargets: oc
    .input(
      z.object({
        skillId: Id,
        decisions: z.record(Placeholder, DozoTeachValueDecisionSchema).default({}),
      }),
    )
    .output(z.object({ labels: z.record(z.string(), z.string()) })),
  /** Forgets a click's picture at once; the click's step keeps its coordinate. */
  removeTarget: oc
    .input(z.object({ skillId: Id, targetId: TargetId }))
    .output(z.object({ ok: z.literal(true) })),
  /**
   * Decides about the values a skill saved by an older release keeps verbatim in its steps.
   * `steps` are the steps the decisions were made on; `decisions` are keyed by the placeholders
   * `savedSkillLiterals` gives them.
   */
  decideSaved: oc
    .input(
      z.object({
        skillId: Id,
        steps: z.array(z.string().max(20_000)).max(500),
        decisions: z.record(Placeholder, DozoTeachValueDecisionSchema),
      }),
    )
    .output(TaughtSkillSchema),
  /**
   * Keys typed in a row on the computer, in order: each reaches the computer and, while teaching,
   * the recording as one request per key would. Protected input keeps its own request.
   */
  keys: oc
    .input(
      z.object({
        botId: Id,
        keys: z.array(z.string().min(1).max(32)).min(1).max(200),
        /**
         * Where the keys stand among the page's batches for this bot (`seq`, from 1, per `page`),
         * and the batch sent before them that was not answered yet (`after`): the server types
         * and records them only after that one, so a batch sent as the page goes away cannot
         * overtake one still on its way.
         */
        order: z
          .object({
            page: z.string().min(1).max(64),
            seq: z.number().int().positive(),
            after: z.number().int().positive().optional(),
          })
          .optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  /** Runs the draft safely with the decisions applied; nothing is saved or forgotten. */
  test: oc.input(DraftInput).output(z.object({ runId: Id })),
};
