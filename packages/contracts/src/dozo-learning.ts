import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/**
 * Whether a bot learns notes from its owner's own direct chat: `off` (the default, also for a bot
 * never set) or `auto`, where each change is made and listed to undo.
 */
export const DozoLearningMode = z.enum(["off", "auto"]);
export type DozoLearningMode = z.infer<typeof DozoLearningMode>;

/** One line a review added, changed or removed in the bot's notes; `undoneAt` once undone. */
export const DozoLearningChangeSchema = z.object({
  id: Id,
  kind: z.enum(["add", "update", "remove"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
  createdAt: z.string(),
  undoneAt: z.string().nullable(),
});
export type DozoLearningChange = z.infer<typeof DozoLearningChangeSchema>;

/** One note is one line of at most this many characters. */
export const DOZO_LEARNING_NOTE_MAX_CHARS = 200;

/**
 * Control characters (C0, DEL, C1 with U+0085) and the Unicode line and paragraph separators:
 * any of them could start a new line where the notes are shown to a model.
 */
const NOTE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * One learned note: a single line that cannot close or open the block the notes are shown in
 * (no angle brackets) nor read as a heading of it (no leading "#").
 */
export const DozoLearningNoteText = z
  .string()
  .trim()
  .min(1)
  .max(DOZO_LEARNING_NOTE_MAX_CHARS)
  .refine((text) => !NOTE_BREAK.test(text), "One line, no control characters.")
  .refine((text) => !/[<>]/.test(text), "No angle brackets.")
  .refine((text) => !text.startsWith("#"), "No heading.");

/** What a learned note says about the owner. */
export const DozoLearningNoteKind = z.enum(["fact", "preference", "correction"]);

/** How many of the latest changes `get` answers. */
export const DOZO_LEARNING_CHANGES_SHOWN = 20;

/** The answer to an undo of a change whose line was edited since. */
export const DOZO_LEARNING_CHANGED_CODE = "LEARNING_CHANGED_SINCE";

export const dozoLearningContract = /* @__PURE__ */ (() => ({
  /** Only to the bot's owner: the learning mode and its latest changes, newest first. */
  get: oc
    .input(z.object({ botId: Id }))
    .output(
      z.object({
        mode: DozoLearningMode,
        /** False in a Space with another member or guest: no learning there, whatever the mode. */
        available: z.boolean(),
        changes: z.array(DozoLearningChangeSchema),
      }),
    ),
  /** Only the bot's owner may change this: it is their own chat that becomes notes. */
  setMode: oc
    .input(z.object({ botId: Id, mode: DozoLearningMode }))
    .output(z.object({ mode: DozoLearningMode })),
  /** The bot's owner undoes one change while its line is still as the review left it. */
  undo: oc.input(z.object({ changeId: Id })).output(DozoLearningChangeSchema),
}))();
