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

const DraftInput = z.object({
  skillId: Id,
  name: z.string().max(200).optional(),
  playbook: SkillPlaybookSchema,
  decisions: z.record(Placeholder, DozoTeachValueDecisionSchema).default({}),
});

export const dozoTeachContract = {
  /** The values typed while teaching; only the person who taught the skill gets them. */
  review: oc
    .input(z.object({ skillId: Id }))
    .output(z.object({ values: z.array(DozoTeachValueSchema) })),
  /** Saves the draft with the decisions applied and forgets what was typed, at once. */
  save: oc.input(DraftInput).output(TaughtSkillSchema),
  /** Runs the draft safely with the decisions applied; nothing is saved or forgotten. */
  test: oc.input(DraftInput).output(z.object({ runId: Id })),
};
