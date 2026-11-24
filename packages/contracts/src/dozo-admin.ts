import { oc } from "@orpc/contract";
import * as z from "zod";
import { dozoAdminAccessContract } from "./dozo-admin-access.js";
import { Id, IsoDate } from "./ids.js";

/** One account as the hosted deployment's admin page lists it. Nothing an account holds is here. */
export const DozoAdminUserSchema = /* @__PURE__ */ (() =>
  z.object({
    id: Id,
    email: z.string(),
    name: z.string(),
    createdAt: IsoDate,
    /** When a sign-in of this account was last used; null without one. */
    lastSeenAt: IsoDate.nullable(),
    bots: z.number().int(),
    runningComputers: z.number().int(),
    suspended: z.boolean(),
    /** Its address, or its domain, is on the ban list. */
    banned: z.boolean(),
  }))();
export type DozoAdminUser = z.infer<typeof DozoAdminUserSchema>;

export const DozoAdminUsersSortSchema = /* @__PURE__ */ (() =>
  z.enum(["newest", "oldest", "email"]))();
export type DozoAdminUsersSort = z.infer<typeof DozoAdminUsersSortSchema>;
export const DozoAdminUserStatusSchema = /* @__PURE__ */ (() => z.enum(["active", "suspended"]))();

/** One account in full, for its own admin page. Still nothing an account holds. */
export const DozoAdminAccountSchema = /* @__PURE__ */ (() =>
  DozoAdminUserSchema.omit({
    lastSeenAt: true,
    bots: true,
    runningComputers: true,
  }).extend({
    emailVerified: z.boolean(),
    /** A deployment admin: the page offers no suspending or deleting it. */
    admin: z.boolean(),
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
  }))();
export type DozoAdminAccount = z.infer<typeof DozoAdminAccountSchema>;

export const DozoAdminComputerSchema = /* @__PURE__ */ (() =>
  z.object({
    id: Id,
    /** Null when the owning account is gone. */
    email: z.string().nullable(),
    bots: z.array(z.string()),
    runningSince: IsoDate.nullable(),
  }))();
export type DozoAdminComputer = z.infer<typeof DozoAdminComputerSchema>;

/** A refused address (`ada@example.com`) or a refused domain with its subdomains (`example.com`). */
export const DozoAdminBanSchema = /* @__PURE__ */ (() =>
  z.object({
    value: z.string(),
    createdAt: IsoDate,
  }))();
export type DozoAdminBan = z.infer<typeof DozoAdminBanSchema>;

/** Every procedure is refused with FORBIDDEN unless the caller is a deployment admin. */
export const dozoAdminContract = /* @__PURE__ */ (() => ({
  users: oc
    .input(
      z.object({
        query: z.string().max(254).optional(),
        cursor: Id.optional(),
        /** Newest first by default. */
        sort: DozoAdminUsersSortSchema.optional(),
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
  /** Free-access grants an account has not received yet, beside upstream's list, create, revoke. */
  accessGrants: dozoAdminAccessContract,
}))();
