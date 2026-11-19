import { ClientError } from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterContext } from "./routes/context.js";

/** A grant no account has claimed or received yet. */
const UNCLAIMED = { appliedAt: null, organizationId: null } as const;

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

  const record = (adminId: string, change: "updated" | "deleted", grant: string) =>
    recordSecurityEvent({
      type: "deployment.settings.changed",
      userId: adminId,
      metadata: { setting: "access_grant", change, grant },
    });

  return {
    update: admin.dozoAdmin.accessGrants.update.handler(async ({ context, input }) => {
      // Matched on its state, so a sign-up claiming it at the same moment wins or loses whole.
      const { count } = await prisma.accessGrant.updateMany({
        where: { id: input.id, ...UNCLAIMED, revokedAt: null },
        data: input.grant,
      });
      if (count === 0) await refusal(input.id, "Only a pending grant can be changed");
      await record(context.actor.userId, "updated", input.id);
      return { ok: true as const };
    }),

    delete: admin.dozoAdmin.accessGrants.delete.handler(async ({ context, input }) => {
      const { count } = await prisma.accessGrant.deleteMany({
        where: { id: input.id, ...UNCLAIMED },
      });
      if (count === 0) await refusal(input.id, "A received grant cannot be deleted");
      await record(context.actor.userId, "deleted", input.id);
      return { ok: true as const };
    }),
  };
}
