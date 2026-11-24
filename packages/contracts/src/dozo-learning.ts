import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/**
 * Whether a bot learns from its owner's own direct chat: `off` (the default, also for a bot never
 * set); `ask`, where it only suggests a skill for the owner to save; or `auto`, where it also
 * writes notes itself, each listed to undo. A skill is never saved without the owner.
 */
export const DozoLearningMode = /* @__PURE__ */ (() => z.enum(["off", "ask", "auto"]))();
export type DozoLearningMode = z.infer<typeof DozoLearningMode>;

/** One line a review added, changed or removed in the bot's notes; `undoneAt` once undone. */
export const DozoLearningChangeSchema = /* @__PURE__ */ (() =>
  z.object({
    id: Id,
    kind: z.enum(["add", "update", "remove"]),
    before: z.string().nullable(),
    after: z.string().nullable(),
    createdAt: z.string(),
    undoneAt: z.string().nullable(),
  }))();
export type DozoLearningChange = z.infer<typeof DozoLearningChangeSchema>;

/** One note is one line of at most this many characters. */
export const DOZO_LEARNING_NOTE_MAX_CHARS = 200;

/**
 * Characters a note may not hold: control characters (C0, DEL, C1 with U+0085) and the Unicode
 * line and paragraph separators, any of which could start a new line where the notes are shown to
 * a model; bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069), which reorder what the
 * owner sees; and tag characters (U+E0000-U+E007F), which a reader does not see at all.
 */
const unsafeChar = (text: string) =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      (code >= 0xe0000 && code <= 0xe007f)
    );
  });

/**
 * One learned line of at most `max` characters: a single line that cannot close or open the block
 * it is shown to a model in (no angle brackets) nor read as a heading of it (no leading "#").
 */
export const dozoLearningLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !unsafeChar(text), "One line, no control or hidden characters.")
    .refine((text) => !/[<>]/.test(text), "No angle brackets.")
    .refine((text) => !text.startsWith("#"), "No heading.");

/** One learned note. */
export const DozoLearningNoteText = /* @__PURE__ */ (() =>
  dozoLearningLine(DOZO_LEARNING_NOTE_MAX_CHARS))();

/** What a learned note says about the owner. */
export const DozoLearningNoteKind = /* @__PURE__ */ (() =>
  z.enum(["fact", "preference", "correction"]))();

/** How many of the latest changes `get` answers. */
export const DOZO_LEARNING_CHANGES_SHOWN = 20;

/** The answer to an undo of a change whose line was edited since. */
export const DOZO_LEARNING_CHANGED_CODE = "LEARNING_CHANGED_SINCE";

export const dozoLearningContract = /* @__PURE__ */ (() => ({
  /** Only to the bot's owner: the learning mode and its latest changes, newest first. */
  get: oc.input(z.object({ botId: Id })).output(
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
