import { BYOK_TIERS, PLAN_LIMIT_CODES, SHARED_SPACE_FULL_MESSAGE } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { PlanGrant } from "./dozo-plan-grant.js";
import { DOZO_PLAN_GRANT_SELECT, paidTierOf, tierInForce } from "./dozo-plan-grant.js";
import type { PlanLimitsByTier } from "./dozo-plan-quotas.js";
import { readPlanLimits } from "./dozo-plan-quotas.js";
import { runAsSystem, runAsSystemInTransaction } from "./row-security.js";

/** The organization's files already fill its plan's shared space, so a new one is refused. */
export class SharedSpaceFullError extends ClientError {
  constructor() {
    super("BAD_REQUEST", SHARED_SPACE_FULL_MESSAGE, PLAN_LIMIT_CODES.sharedSpaceFull);
    this.name = "SharedSpaceFullError";
  }
}

type PlanBilling = { status: string | null; byokTier: string | null } | null | undefined;

/**
 * The plan an organization is on: the tier in force, a live subscription's or a plan an admin
 * granted that has not ended, whichever is higher, else the first one. So an organization whose
 * plan ended keeps its files and only stops adding to them. Every reader of the plan comes here.
 * Its shared space is the admin's quota for the plan where one is set, else the plan's terms.
 */
function planTerms(
  billing: PlanBilling,
  grant: PlanGrant | null | undefined,
  limits: PlanLimitsByTier,
  now = new Date(),
): { name: string; sharedSpaceBytes: number | undefined } {
  const tier = tierInForce(paidTierOf(billing), grant, now) ?? "standard";
  return { name: BYOK_TIERS[tier].name, sharedSpaceBytes: limits[tier].sharedSpaceBytes };
}

/** Whether the server bills. One that does not has no plans, so no limit. */
async function serverBills(tx: Pick<PrismaClient, "deploymentSettings">) {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { modelCreditsEnabled: true },
  });
  return settings?.modelCreditsEnabled === true;
}

/** The bytes of files the Space's organization may keep, or null without a limit. */
async function sharedSpaceLimit(
  tx: Pick<PrismaClient, "deploymentSettings" | "space" | "dozoPlanQuota">,
  spaceId: string,
): Promise<{ organizationId: string; bytes: number } | null> {
  if (!(await serverBills(tx))) return null;
  const space = await tx.space.findUnique({
    where: { id: spaceId },
    select: {
      organizationId: true,
      organization: {
        select: {
          billing: { select: { status: true, byokTier: true } },
          dozoPlanGrant: { select: DOZO_PLAN_GRANT_SELECT },
        },
      },
    },
  });
  if (!space) return null;
  const { sharedSpaceBytes } = planTerms(
    space.organization.billing,
    space.organization.dozoPlanGrant,
    await readPlanLimits(tx),
  );
  return sharedSpaceBytes === undefined
    ? null
    : { organizationId: space.organizationId, bytes: sharedSpaceBytes };
}

/** The recorded bytes of every file the organization keeps. Runs across its Spaces. */
async function usedBytes(db: Pick<PrismaClient, "$queryRaw">, organizationId: string) {
  // ponytail: sums every file row of the organization on each write; keep a running total per
  // organization when one holds enough files for this to show.
  const [{ used }] = await db.$queryRaw<[{ used: string }]>(Prisma.sql`
    SELECT COALESCE(SUM(a."size"), 0)::text AS "used"
    FROM "artifacts" a JOIN "spaces" s ON s."id" = a."spaceId"
    WHERE s."organizationId" = ${organizationId}
  `);
  return BigInt(used);
}

/**
 * The refusal a new file would meet when the organization has no room left, else null. A look
 * without the lock, for work that costs something before it has a file to keep: it saves starting
 * that work for nothing, and the write itself is still held to the limit by `holdSharedSpace`.
 */
export async function sharedSpaceFull(
  prisma: Pick<PrismaClient, "deploymentSettings" | "space" | "dozoPlanQuota" | "$queryRaw">,
  spaceId: string,
): Promise<SharedSpaceFullError | null> {
  const limit = await sharedSpaceLimit(prisma, spaceId);
  if (!limit) return null;
  const used = await runAsSystem("an organization's files span its Spaces", () =>
    usedBytes(prisma, limit.organizationId),
  );
  return used >= BigInt(limit.bytes) ? new SharedSpaceFullError() : null;
}

/**
 * The organization's plan by name and how much of its shared space its files take, for showing;
 * null where files have no limit. `billing` is the organization's billing account as the caller
 * already read it, and `grant` the organization's granted plan as `planGrantOf` reads it. The same
 * plan and count the writes are held to.
 */
export async function sharedSpaceUsage(
  prisma: Pick<PrismaClient, "deploymentSettings" | "dozoPlanQuota" | "$queryRaw">,
  organizationId: string,
  billing: PlanBilling,
  grant: PlanGrant | null | undefined,
): Promise<{ plan: string; usedBytes: number; limitBytes: number } | null> {
  if (!(await serverBills(prisma))) return null;
  const { name, sharedSpaceBytes } = planTerms(billing, grant, await readPlanLimits(prisma));
  if (sharedSpaceBytes === undefined) return null;
  const used = await runAsSystem("an organization's files span its Spaces", () =>
    usedBytes(prisma, organizationId),
  );
  return { plan: name, usedBytes: Number(used), limitBytes: sharedSpaceBytes };
}

/**
 * Refuses the transaction's new files when they take the organization over its shared space.
 * Call it in the transaction that added the artifact rows, after adding them and as its last
 * step: it waits for the organization's other writes to commit and then counts the recorded
 * sizes, this transaction's rows included, so writes running together cannot pass the limit
 * between them. Nothing is deleted or hidden: only the write that goes over is refused.
 */
export async function holdSharedSpace(tx: Prisma.TransactionClient, spaceId: string) {
  const limit = await sharedSpaceLimit(tx, spaceId);
  if (!limit) return;
  await runAsSystemInTransaction(tx, "an organization's files span its Spaces", async () => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`dozo-shared-space:${limit.organizationId}`}, 0))::text AS "lock"
    `);
    if ((await usedBytes(tx, limit.organizationId)) > BigInt(limit.bytes))
      throw new SharedSpaceFullError();
  });
}

/**
 * Whether an upload's transaction only found the file an earlier try had already added: the
 * upload route answers `{ replay: true }` then. It added nothing, so it is not held to the limit.
 * Told by the caller and not read off the rows, so anything else is checked.
 */
export function isReplayedUpload(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "replay" in result && result.replay === true
  );
}

/** Runs a write that adds artifact rows to the Space in a transaction held to its shared space. */
export function withSharedSpace<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  spaceId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await write(tx);
    await holdSharedSpace(tx, spaceId);
    return result;
  });
}
