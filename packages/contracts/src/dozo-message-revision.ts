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
  /** How many messages changing each named one removes, for the confirm and to send back. */
  removedCounts: z.record(Id, z.number().int().nonnegative()).optional(),
  /** The chat's newest message, the last any change removes; sent back with the count. */
  lastMessageId: Id.nullable().optional(),
  /**
   * The chat's latest replies a backup model wrote instead of the chosen one, by message: that
   * model's name, for the message's menu. Absent when there are none.
   */
  backupReplies: z.record(Id, z.string()).optional(),
});
export type DozoRevisable = z.infer<typeof DozoRevisableSchema>;

const ThreadInput = z.object({ threadId: Id });

/**
 * What the person confirmed a change removes, as `revisable` named it. The server refuses a change
 * that would remove anything else; without it, only a change to the newest turn goes ahead.
 */
export const DozoRevisionConfirmedSchema = z.object({
  removes: z.number().int().nonnegative(),
  lastMessageId: Id.nullable(),
});
export type DozoRevisionConfirmed = z.infer<typeof DozoRevisionConfirmedSchema>;
const RevisedOutput = z.object({ runId: Id });

export const dozoMessagesContract = /* @__PURE__ */ (() => ({
  revisable: oc.input(ThreadInput).output(DozoRevisableSchema),
  /** Replaces the text of a message the server named, removes what followed it, and runs the bot. */
  edit: oc
    .input(
      ThreadInput.extend({
        messageId: Id,
        text: z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH),
        confirmed: DozoRevisionConfirmedSchema.optional(),
      }),
    )
    .output(RevisedOutput),
  /** Removes a reply the server named and what followed it, and runs the bot again. */
  regenerate: oc
    .input(ThreadInput.extend({ messageId: Id, confirmed: DozoRevisionConfirmedSchema.optional() }))
    .output(RevisedOutput),
  ...dozoMessagePinsContract,
}))();
