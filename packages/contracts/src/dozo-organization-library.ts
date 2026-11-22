import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/**
 * The skill library of the organization the open Space belongs to: the skills in it, which every
 * member of its Spaces reads (`agentSkills.list` already lists them, read only for all but their
 * owner), and whether the caller, its owner, may put one of theirs in.
 */
export const DozoOrganizationLibrarySchema = z.object({
  skillIds: z.array(Id),
  canShare: z.boolean(),
});
export type DozoOrganizationLibrary = z.infer<typeof DozoOrganizationLibrarySchema>;

export const dozoOrganizationLibraryContract = {
  get: oc.output(DozoOrganizationLibrarySchema),
  /** The organization's owner only, for a skill they wrote themselves. */
  share: oc
    .input(z.object({ skillId: Id, shared: z.boolean() }))
    .output(DozoOrganizationLibrarySchema),
};
