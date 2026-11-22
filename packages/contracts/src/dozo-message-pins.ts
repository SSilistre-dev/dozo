import { oc } from "@orpc/contract";
import * as z from "zod";
import { ReplyPreviewSchema } from "./events.js";
import { Id } from "./ids.js";

/** Pins hold at most this many messages per chat and person; the oldest go first past it. */
export const DOZO_MESSAGE_PINS_MAX = 50;

/**
 * Messages a person pinned in a chat they can read. Pins are that person's own: other members of
 * the Space never see them. Newest first.
 */
export const DozoMessagePinSchema = z.object({
  messageId: Id,
  preview: ReplyPreviewSchema,
});
export type DozoMessagePin = z.infer<typeof DozoMessagePinSchema>;

const ThreadInput = z.object({ threadId: Id });

export const dozoMessagePinsContract = /* @__PURE__ */ (() => ({
  pins: oc
    .input(ThreadInput)
    .output(z.object({ pins: z.array(DozoMessagePinSchema).max(DOZO_MESSAGE_PINS_MAX) })),
  /** Pins or unpins one message; doing what is already done succeeds. */
  pin: oc
    .input(ThreadInput.extend({ messageId: Id, pinned: z.boolean() }))
    .output(z.object({ pinned: z.boolean() })),
}))();
