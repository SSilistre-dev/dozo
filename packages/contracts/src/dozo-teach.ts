import { oc } from "@orpc/contract";
import * as z from "zod";
import { SkillPlaybookSchema, TaughtSkillSchema } from "./domain.js";
import { Id } from "./ids.js";

/** A value typed while teaching, as its placeholder in the steps names it (`{{value N}}`). */
const Placeholder = z.string().regex(/^\{\{value \d+\}\}$/);

/** What becomes of one typed value: an input asked for on each run, kept as typed, or dropped. */
export const DozoTeachValueDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("variable"), name: z.string().min(1).max(80) }),
  z.object({ action: z.literal("fixed") }),
  z.object({ action: z.literal("remove") }),
]);
export type DozoTeachValueDecision = z.infer<typeof DozoTeachValueDecisionSchema>;

export const DozoTeachValueSchema = z.object({
  placeholder: Placeholder,
  /** Null for protected input, whose text is never stored. */
  text: z.string().nullable(),
  /** Protected input, or text that looks like a password, PIN or key: never kept as text. */
  secret: z.boolean(),
  /** A name the model suggested for it, when one was made. */
  suggestion: z.object({ name: z.string() }).optional(),
});
export type DozoTeachValue = z.infer<typeof DozoTeachValueSchema>;

/**
 * What one recorded click hit, kept in the recording beside its events until the save: the
 * window it was in and a small WebP of the screen around it (base64). `eventIndex` is the click's
 * event; a click before a secret value has no image.
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
  /** What the model saw was clicked, in a few words, when it could tell. */
  label: z.string().optional(),
});
export type DozoTeachTarget = z.infer<typeof DozoTeachTargetSchema>;

const DraftInput = z.object({
  skillId: Id,
  name: z.string().max(200).optional(),
  playbook: SkillPlaybookSchema,
  decisions: z.record(Placeholder, DozoTeachValueDecisionSchema).default({}),
  /** Targets the teacher removed: their steps keep only the coordinate. */
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
  /** Saves the draft with the decisions applied, then forgets what was typed. */
  save: oc.input(DraftInput).output(TaughtSkillSchema),
  /** Runs the draft safely with the decisions applied; nothing is saved or forgotten. */
  test: oc.input(DraftInput).output(z.object({ runId: Id })),
};
