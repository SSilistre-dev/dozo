import { oc } from "@orpc/contract";
import * as z from "zod";
import { ByokTierSchema } from "./billing.js";
import { dozoAdminAccessContract } from "./dozo-admin-access.js";
import { dozoAdminBillingContract } from "./dozo-admin-billing.js";
import { dozoAdminFunnelContract } from "./dozo-admin-funnel.js";
import { dozoAdminPlansContract } from "./dozo-admin-plans.js";
import { Id, IsoDate } from "./ids.js";

export * from "./dozo-admin-billing.js";
export * from "./dozo-admin-funnel.js";
export * from "./dozo-admin-plans.js";
/**
 * When the plan in force ends or renews, as the member's own billing status tells it (`PlanEnd`),
 * and what keeps it until then: the subscription's period, a trial, a plan an admin granted, or on
 * Free a free period. Days left are counted where it is shown (`planEndDays`).
 */
export const DozoAdminPlanEndSchema = z.object({
  source: z.enum(["subscription", "trial", "granted", "freeMonth"]),
  at: IsoDate,
  renews: z.boolean(),
  /** A granted plan above a subscription: the subscription's plan follows it. */
  fallsTo: z.object({ from: z.string(), to: z.string() }).optional(),
});
export type DozoAdminPlanEnd = z.infer<typeof DozoAdminPlanEndSchema>;

/** The plan an account has in force, and until when an admin's grant of it lasts. */
export const DozoAdminPlanSchema = z.object({
  tier: ByokTierSchema,
  /** The end of a plan an admin granted that has not ended; null without one. */
  grantedUntil: IsoDate.nullable(),
  /** Null on Free with nothing running out. */
  ends: DozoAdminPlanEndSchema.nullable(),
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
  /** Its address, or its domain, is on the ban list. */
  banned: z.boolean(),
});
export type DozoAdminUser = z.infer<typeof DozoAdminUserSchema>;

export const DozoAdminUsersSortSchema = z.enum(["newest", "oldest", "email"]);
export type DozoAdminUsersSort = z.infer<typeof DozoAdminUsersSortSchema>;
export const DozoAdminUserStatusSchema = z.enum(["active", "suspended"]);

/** One account in full, for its own admin page. Still nothing an account holds. */
export const DozoAdminAccountSchema = DozoAdminUserSchema.omit({
  lastSeenAt: true,
  bots: true,
  runningComputers: true,
}).extend({
  emailVerified: z.boolean(),
  /** A deployment admin: the page offers no suspending or deleting it. */
  admin: z.boolean(),
  /** The subscription as last synced; null without one. */
  billing: z
    .object({
      status: z.string().nullable(),
      trialEndsAt: IsoDate.nullable(),
      currentPeriodEndsAt: IsoDate.nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  /** The end of a free period that is still running; null without one. */
  freeUntil: IsoDate.nullable(),
  /** What the organization's files take of its plan's shared space; null without a limit. */
  storage: z.object({ usedBytes: z.number(), limitBytes: z.number() }).nullable(),
  spaces: z.array(z.object({ id: Id, name: z.string(), owned: z.boolean() })),
  bots: z.array(z.object({ id: Id, name: z.string() })),
  computers: z.array(
    z.object({
      id: Id,
      running: z.boolean(),
      /** On the person's own machine rather than the deployment's. */
      ownMachine: z.boolean(),
      runningSince: IsoDate.nullable(),
      bots: z.array(z.string()),
    }),
  ),
  /** The most recently used sign-ins, newest first. */
  sessions: z.array(
    z.object({
      id: Id,
      createdAt: IsoDate,
      lastUsedAt: IsoDate,
      userAgent: z.string().nullable(),
    }),
  ),
});
export type DozoAdminAccount = z.infer<typeof DozoAdminAccountSchema>;

export const DozoAdminComputerSchema = z.object({
  id: Id,
  /** Null when the owning account is gone. */
  email: z.string().nullable(),
  bots: z.array(z.string()),
  runningSince: IsoDate.nullable(),
});
export type DozoAdminComputer = z.infer<typeof DozoAdminComputerSchema>;

/** A refused address (`ada@example.com`) or a refused domain with its subdomains (`example.com`). */
export const DozoAdminBanSchema = z.object({ value: z.string(), createdAt: IsoDate });
export type DozoAdminBan = z.infer<typeof DozoAdminBanSchema>;

/** Every procedure is refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminContract = {
  users: oc
    .input(
      z.object({
        query: z.string().max(254).optional(),
        cursor: Id.optional(),
        /** Newest first by default. */
        sort: DozoAdminUsersSortSchema.optional(),
        /** Only accounts on this plan now. */
        plan: ByokTierSchema.optional(),
        status: DozoAdminUserStatusSchema.optional(),
      }),
    )
    .output(
      z.object({
        signupsOpen: z.boolean(),
        /** Every account, whatever the search. */
        total: z.number().int(),
        /** The accounts the search and filters match. */
        matching: z.number().int(),
        users: z.array(DozoAdminUserSchema),
        nextCursor: Id.nullable(),
      }),
    ),
  /** One account in full. NOT_FOUND for an unknown account or an internal chat-app row. */
  user: oc.input(z.object({ userId: Id })).output(DozoAdminAccountSchema),
  rename: oc
    .input(z.object({ userId: Id, name: z.string().trim().min(1).max(100) }))
    .output(z.object({ name: z.string() })),
  /** Signs the account out everywhere: its sessions, paired computers and notification sign-ups. */
  endSessions: oc.input(z.object({ userId: Id })).output(z.object({ ok: z.literal(true) })),
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
    z.object({
      total: z.number().int(),
      computers: z.array(DozoAdminComputerSchema),
      /** What the running computers hold against the total the operator set; absent without one. */
      memory: z.object({ usedGb: z.number(), totalGb: z.number() }).optional(),
    }),
  ),
  bans: oc.output(z.object({ bans: z.array(DozoAdminBanSchema) })),
  /**
   * Refuses sign-up and sign-in for an address or a domain. Naming an account bans its address and
   * suspends it. The entry comes back as stored: lower case, without a `+tag`.
   */
  ban: oc
    .input(z.union([z.object({ userId: Id }), z.object({ value: z.string().max(254) })]))
    .output(z.object({ value: z.string() })),
  unban: oc
    .input(z.object({ value: z.string().max(254) }))
    .output(z.object({ ok: z.literal(true) })),
  /** Deletes the account and what it holds, as the account's own deletion does. Cannot be undone. */
  deleteUser: oc.input(z.object({ userId: Id })).output(z.object({ ok: z.literal(true) })),
  stopComputer: oc.input(z.object({ computerId: Id })).output(z.object({ ok: z.literal(true) })),
  /** The billing page: `/admin/billing`. */
  billing: dozoAdminBillingContract,
  /** The sign-up funnel: `/admin/funnel`. */
  funnel: dozoAdminFunnelContract,
  /** The plans page: `/admin/plans`. */
  plans: dozoAdminPlansContract,
  /** Free-access grants an account has not received yet, beside upstream's list, create, revoke. */
  accessGrants: dozoAdminAccessContract,
};
