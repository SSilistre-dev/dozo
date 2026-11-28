import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/**
 * A routine's spoken briefing as its owner sees it in the routine editor. `available` is false
 * when the owner's own voice connection cannot speak, the routine's bot has no voice of its own,
 * or no other bot of theirs has one; the editor then shows nothing unless a co-host is still set.
 */
export const DozoSpokenBriefingSchema = /* @__PURE__ */ (() =>
  z.object({
    available: z.boolean(),
    coHostBotId: Id.nullable(),
    coHosts: z.array(z.object({ id: Id, name: z.string() })).max(500),
  }))();
export type DozoSpokenBriefing = z.infer<typeof DozoSpokenBriefingSchema>;

/** Only the routine's owner reads and sets it; anything else is not found. */
export const dozoSpokenBriefingsContract = /* @__PURE__ */ (() => ({
  get: oc.input(z.object({ routineId: Id })).output(DozoSpokenBriefingSchema),
  /** Null turns the briefing off; a co-host that is not one of `coHosts` is not found. */
  set: oc
    .input(z.object({ routineId: Id, coHostBotId: Id.nullable() }))
    .output(DozoSpokenBriefingSchema),
}))();
