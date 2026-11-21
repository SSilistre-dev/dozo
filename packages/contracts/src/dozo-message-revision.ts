import { oc } from "@orpc/contract";
import * as z from "zod";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "./domain.js";
import { dozoMessagePinsContract } from "./dozo-message-pins.js";
import { Id } from "./ids.js";

export * from "./dozo-message-pins.js";

/**
 * Editing a message and regenerating a reply in a person's own chat with a bot. The server decides
 * which messages each applies to; clients only offer what it names.
 */
export const DozoRevisableSchema = z.object({
  /** The caller's last message, when it can be edited and sent again. */
  editMessageId: Id.nullable(),
  /** The bot's last reply, when it can be written again. */
  regenerateMessageId: Id.nullable(),
  /**
   * Earlier messages of the caller's that can be edited, and earlier replies that can be written
   * again. Either removes every later message, so clients confirm it first. Absent when none.
   */
  earlierEditMessageIds: z.array(Id).optional(),
  earlierRegenerateMessageIds: z.array(Id).optional(),
  /** How many messages changing each earlier one removes, for the confirm. */
  removedCounts: z.record(Id, z.number().int().positive()).optional(),
});
export type DozoRevisable = z.infer<typeof DozoRevisableSchema>;

const ThreadInput = z.object({ threadId: Id });
const RevisedOutput = z.object({ runId: Id });

export const dozoMessagesContract = {
  revisable: oc.input(ThreadInput).output(DozoRevisableSchema),
  /** Replaces the text of a message the server named, removes what followed it, and runs the bot. */
  edit: oc
    .input(
      ThreadInput.extend({
        messageId: Id,
        text: z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH),
      }),
    )
    .output(RevisedOutput),
  /** Removes a reply the server named and what followed it, and runs the bot again. */
  regenerate: oc.input(ThreadInput.extend({ messageId: Id })).output(RevisedOutput),
  ...dozoMessagePinsContract,
};
