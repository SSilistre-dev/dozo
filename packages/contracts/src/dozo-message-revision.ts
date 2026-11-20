import { oc } from "@orpc/contract";
import * as z from "zod";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "./domain.js";
import { Id } from "./ids.js";

/**
 * Editing the last message and regenerating the last reply in a person's own chat with a bot.
 * The server decides which message, if any, each applies to; clients only offer what it names.
 */
export const DozoRevisableSchema = z.object({
  /** The caller's last message, when it can be edited and sent again. */
  editMessageId: Id.nullable(),
  /** The bot's last reply, when it can be written again. */
  regenerateMessageId: Id.nullable(),
});
export type DozoRevisable = z.infer<typeof DozoRevisableSchema>;

const ThreadInput = z.object({ threadId: Id });
const RevisedOutput = z.object({ runId: Id });

export const dozoMessagesContract = {
  revisable: oc.input(ThreadInput).output(DozoRevisableSchema),
  /** Replaces the text of the caller's last message and runs the bot on it again. */
  edit: oc
    .input(
      ThreadInput.extend({
        messageId: Id,
        text: z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH),
      }),
    )
    .output(RevisedOutput),
  /** Removes the bot's last reply and runs the bot again on the message it answered. */
  regenerate: oc.input(ThreadInput.extend({ messageId: Id })).output(RevisedOutput),
};
