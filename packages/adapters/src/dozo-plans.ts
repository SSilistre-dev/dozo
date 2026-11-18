import type { PrismaClient } from "@rakazo/db";
import {
  DOZO_PLAN_GRANT_SELECT,
  hasBillingAccess,
  organizationForMember,
  tierInForce,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { modelCreditBillingEnabled } from "./run-model.js";

type BillingDeps = Pick<ExecutorDeps, "billingEnabled"> & { prisma: PrismaClient };

/**
 * Whether a run may use what the operator pays for by the call (media generation, an external
 * reviewer): always on a server that does not bill, else only for an organization that pays, with
 * a live subscription, a credit balance, or a plan an admin granted that has not ended. A guest is
 * paid for by their own organization. The operator's model is not decided here: credits already
 * meter it.
 */
export async function operatorPaysFor(
  deps: BillingDeps,
  scope: { userId: string; spaceId: string },
): Promise<boolean> {
  if (!(await modelCreditBillingEnabled(deps))) return true;
  const membership = await organizationForMember(deps.prisma, scope);
  if (!membership) return false;
  const organization = await deps.prisma.organization.findUnique({
    where: { id: membership.organizationId },
    select: {
      billing: { select: { status: true } },
      modelCredits: { select: { balanceMicros: true } },
      dozoPlanGrant: { select: DOZO_PLAN_GRANT_SELECT },
    },
  });
  return (
    hasBillingAccess(organization?.billing?.status ?? null) ||
    tierInForce(null, organization?.dozoPlanGrant) !== null ||
    (organization?.modelCredits?.balanceMicros ?? 0n) > 0n
  );
}

/** The run's services without the ones an organization on Free may not spend the operator's money on. */
export async function planRunServices<T extends { mediaGeneration?: unknown }>(
  services: T,
  hold: { deps: BillingDeps; run: { userId: string; spaceId: string } },
): Promise<T> {
  return (await operatorPaysFor(hold.deps, hold.run))
    ? services
    : { ...services, mediaGeneration: undefined };
}
