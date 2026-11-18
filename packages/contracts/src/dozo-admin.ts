import { oc } from "@orpc/contract";
import * as z from "zod";
import { ByokTierSchema } from "./billing.js";
import { Id, IsoDate } from "./ids.js";

/** The plan an account has in force, and until when an admin's grant of it lasts. */
export const DozoAdminPlanSchema = z.object({
  tier: ByokTierSchema,
  /** The end of a plan an admin granted that has not ended; null without one. */
  grantedUntil: IsoDate.nullable(),
});
export type DozoAdminPlan = z.infer<typeof DozoAdminPlanSchema>;

/** The tiers an admin can grant; Free is what everyone has. */
export const DozoGrantTierSchema = z.enum(["pro", "max"]);

/** One account as the hosted deployment's admin page lists it. Nothing an account holds is here. */
export const DozoAdminUserSchema = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  createdAt: IsoDate,
  /** When a sign-in of this account was last used; null without one. */
  lastSeenAt: IsoDate.nullable(),
  bots: z.number().int(),
  runningComputers: z.number().int(),
  suspended: z.boolean(),
  plan: DozoAdminPlanSchema,
});
export type DozoAdminUser = z.infer<typeof DozoAdminUserSchema>;

export const DozoAdminComputerSchema = z.object({
  id: Id,
  /** Null when the owning account is gone. */
  email: z.string().nullable(),
  bots: z.array(z.string()),
  runningSince: IsoDate.nullable(),
});
export type DozoAdminComputer = z.infer<typeof DozoAdminComputerSchema>;

/** Every procedure is refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminContract = {
  users: oc
    .input(z.object({ query: z.string().max(254).optional(), cursor: Id.optional() }))
    .output(
      z.object({
        signupsOpen: z.boolean(),
        /** Every account, whatever the search. */
        total: z.number().int(),
        users: z.array(DozoAdminUserSchema),
        nextCursor: Id.nullable(),
      }),
    ),
  setSuspended: oc
    .input(z.object({ userId: Id, suspended: z.boolean() }))
    .output(z.object({ suspended: z.boolean() })),
  /**
   * Gives the account's own organization a plan until `endsAt`, replacing any grant it has, or
   * ends the grant when `tier` is null. `endsAt` is required with a tier, must be in the future
   * and at most five years away.
   */
  setPlan: oc
    .input(
      z.object({
        userId: Id,
        tier: DozoGrantTierSchema.nullable(),
        endsAt: IsoDate.optional(),
        note: z.string().max(200).optional(),
      }),
    )
    .output(z.object({ plan: DozoAdminPlanSchema })),
  computers: oc.output(
    z.object({ total: z.number().int(), computers: z.array(DozoAdminComputerSchema) }),
  ),
  stopComputer: oc.input(z.object({ computerId: Id })).output(z.object({ ok: z.literal(true) })),
};
