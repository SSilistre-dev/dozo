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

const DraftInput = z.object({
  skillId: Id,
  name: z.string().max(200).optional(),
  playbook: SkillPlaybookSchema,
  decisions: z.record(Placeholder, DozoTeachValueDecisionSchema).default({}),
  /** Clicks whose picture the teacher removed: their steps keep only the coordinate. */
  removedTargets: z.array(z.string().max(20)).max(1_000).default([]),
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
  /** Runs the draft safely with the decisions applied; nothing is saved or forgotten. */
  test: oc.input(DraftInput).output(z.object({ runId: Id })),
};
