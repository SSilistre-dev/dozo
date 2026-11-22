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

/** How many of the latest changes `get` answers. */
export const DOZO_LEARNING_CHANGES_SHOWN = 20;

/** The answer to an undo of a change whose line was edited since. */
export const DOZO_LEARNING_CHANGED_CODE = "LEARNING_CHANGED_SINCE";

export const dozoLearningContract = /* @__PURE__ */ (() => ({
  /** The bot's learning mode and its latest changes, newest first. */
  get: oc
    .input(z.object({ botId: Id }))
    .output(z.object({ mode: DozoLearningMode, changes: z.array(DozoLearningChangeSchema) })),
  /** Only who may change the bot's run settings may change this. */
  setMode: oc
    .input(z.object({ botId: Id, mode: DozoLearningMode }))
    .output(z.object({ mode: DozoLearningMode })),
  /** Undoes one change while its line is still as the review left it. */
  undo: oc.input(z.object({ changeId: Id })).output(DozoLearningChangeSchema),
}))();
