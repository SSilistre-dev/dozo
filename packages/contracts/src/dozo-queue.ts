import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** Why a piece of work waits. `behind_run` is a message held until the run ahead of it ends. */
export const DozoQueueReason = /* @__PURE__ */ (() =>
  z.enum(["bot_busy", "computer_busy", "behind_run"]))();
export type DozoQueueReason = z.infer<typeof DozoQueueReason>;

/**
 * One piece of work that waits, as the caller may see it. `position` is its place in the line of
 * the bot it waits on, from 1. `label` and `waitingFor` name work only when it is the caller's
 * own (a message's start, a routine's name); anyone else's work carries null and `mine: false`.
 * A run's `id` is the run; a message's `id` is the message.
 */
export const DozoQueueItemSchema = /* @__PURE__ */ (() =>
  z.object({
    id: Id,
    kind: z.enum(["run", "message"]),
    botId: Id,
    position: z.number().int().min(1),
    mine: z.boolean(),
    reason: DozoQueueReason,
    waitingFor: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
  }))();
export type DozoQueueItem = z.infer<typeof DozoQueueItemSchema>;

export const dozoQueueContract = /* @__PURE__ */ (() => ({
  /** What waits for the bot (or the group's bots), in the order it will start. */
  list: oc
    .input(
      z
        .object({ botId: Id.optional(), groupId: Id.optional() })
        .refine((target) => Boolean(target.botId) !== Boolean(target.groupId)),
    )
    .output(z.object({ items: z.array(DozoQueueItemSchema) })),
  /**
   * Stops waiting for the caller's own queued run or held message. Work that already started,
   * and anyone else's, is answered as not found.
   */
  cancelWaiting: oc
    .input(z.union([z.object({ runId: Id }), z.object({ messageId: Id })]))
    .output(z.object({ cancelled: z.literal(true) })),
}))();
