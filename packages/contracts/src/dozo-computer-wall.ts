import { oc } from "@orpc/contract";
import * as z from "zod";
import { ComputerStatusSchema } from "./computers/computer.js";
import { Id } from "./ids.js";

/** One bot's computer as the wall shows it: its state, and whether it has a screen to watch now. */
export const DozoComputerTileSchema = /* @__PURE__ */ (() =>
  z.object({
    botId: Id,
    state: ComputerStatusSchema.shape.state,
    /**
     * The caller's own bot, running, on a kind that can show its screen without waking, extending
     * or taking control of it: `screen` then answers a view-only address.
     */
    screen: z.boolean(),
  }))();
export type DozoComputerTile = z.infer<typeof DozoComputerTileSchema>;

/** Every computer of the caller's Space at a glance; reading it never starts or wakes one. */
export const dozoComputerWallContract = /* @__PURE__ */ (() => ({
  list: oc.output(z.array(DozoComputerTileSchema)),
  /** A view-only address for one tile, or null whenever it cannot be had without side effects. */
  screen: oc.input(z.object({ botId: Id })).output(z.object({ url: z.string().nullable() })),
}))();
