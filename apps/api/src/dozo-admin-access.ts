import { ClientError } from "@rakazo/core";
import { addressFingerprint, recordAdminChange } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

/** A grant no account has claimed or received yet. */
const UNCLAIMED = { appliedAt: null, organizationId: null } as const;
/** What a grant gives, recorded before and after an admin changes or deletes it. */
const GRANT_VALUES = { email: true, creditCents: true, freeMonths: true } as const;

/**
 * Changing and deleting free-access grants no account has received, beside upstream's list,
 * create and revoke (`access-grants.ts`). Gated as upstream's are: a deployment admin, on a
 * deployment that bills. A received grant is never changed or deleted here: its credit and free
 * months are already the account's, and the computer allowance still counts its credit.
 */
export function dozoAdminAccessRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    if (!deps.billing?.modelCreditsEnabled)
      throw new ClientError("NOT_FOUND", "Model credits are not enabled");
    return next();
  });

  /** Why nothing matched: the grant is gone, or it is past the state the change needs. */
  async function refusal(id: string, message: string): Promise<never> {
    const exists = await prisma.accessGrant.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new ClientError("NOT_FOUND", "Grant not found");
    throw new ClientError("CONFLICT", message);
  }

  return {
    update: admin.dozoAdmin.accessGrants.update.handler(async ({ context, input }) => {
      const pending = { id: input.id, ...UNCLAIMED, revokedAt: null };
      // Matched on its state, so a sign-up claiming it at the same moment wins or loses whole.
      // The record goes in the same transaction: a change it cannot record is undone.
      const changed = await prisma.$transaction(async (tx) => {
        const before = await tx.accessGrant.findFirst({ where: pending, select: GRANT_VALUES });
        if (!before) return false;
        const { count } = await tx.accessGrant.updateMany({ where: pending, data: input.grant });
        if (count === 0) return false;
        await recordAdminChange(tx, context.actor.userId, {
          setting: "access_grant",
          change: "updated",
          grant: input.id,
          fromAddress: addressFingerprint(before.email),
          toAddress: addressFingerprint(input.grant.email),
          fromCreditCents: before.creditCents,
          toCreditCents: input.grant.creditCents,
          fromFreeMonths: before.freeMonths,
          toFreeMonths: input.grant.freeMonths,
        });
        return true;
      });
      if (!changed) await refusal(input.id, "Only a pending grant can be changed");
      return { ok: true as const };
    }),

    delete: admin.dozoAdmin.accessGrants.delete.handler(async ({ context, input }) => {
      const unclaimed = { id: input.id, ...UNCLAIMED };
      const deleted = await prisma.$transaction(async (tx) => {
        const before = await tx.accessGrant.findFirst({
          where: unclaimed,
          select: { ...GRANT_VALUES, revokedAt: true },
        });
        if (!before) return false;
        const { count } = await tx.accessGrant.deleteMany({ where: unclaimed });
        if (count === 0) return false;
        await recordAdminChange(tx, context.actor.userId, {
          setting: "access_grant",
          change: "deleted",
          grant: input.id,
          status: before.revokedAt ? "revoked" : "pending",
          address: addressFingerprint(before.email),
          creditCents: before.creditCents,
          freeMonths: before.freeMonths,
        });
        return true;
      });
      if (!deleted) await refusal(input.id, "A received grant cannot be deleted");
      return { ok: true as const };
    }),
  };
}
