import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

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
  /** Its address, or its domain, is on the ban list. */
  banned: z.boolean(),
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

/** A refused address (`ada@example.com`) or a refused domain with its subdomains (`example.com`). */
export const DozoAdminBanSchema = z.object({ value: z.string(), createdAt: IsoDate });
export type DozoAdminBan = z.infer<typeof DozoAdminBanSchema>;

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
};
