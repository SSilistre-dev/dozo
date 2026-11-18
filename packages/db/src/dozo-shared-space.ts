import { BYOK_TIERS, ByokTierSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { hasBillingAccess } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { runAsSystemInTransaction } from "./row-security.js";

/** The organization's files already fill its plan's shared space, so a new one is refused. */
export class SharedSpaceFullError extends ClientError {
  constructor() {
    super(
      "BAD_REQUEST",
      "Shared space is full. Delete files or upgrade the plan.",
      "shared_space_full",
    );
    this.name = "SharedSpaceFullError";
  }
}

/**
 * The bytes of files the Space's organization may keep, or null without a limit: a server that
 * does not bill has none. A live subscription gives its tier's limit, anything else the first
 * tier's, so an organization whose plan ended keeps its files and only stops adding to them.
 */
async function sharedSpaceLimit(
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<{ organizationId: string; bytes: number } | null> {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { modelCreditsEnabled: true },
  });
  if (!settings?.modelCreditsEnabled) return null;
  const space = await tx.space.findUnique({
    where: { id: spaceId },
    select: {
      organizationId: true,
      organization: { select: { billing: { select: { status: true, byokTier: true } } } },
    },
  });
  if (!space) return null;
  const billing = space.organization.billing;
  const paid = hasBillingAccess(billing?.status ?? null)
    ? ByokTierSchema.safeParse(billing?.byokTier).data
    : undefined;
  const terms: { sharedSpaceBytes?: number } = BYOK_TIERS[paid ?? "standard"];
  return terms.sharedSpaceBytes === undefined
    ? null
    : { organizationId: space.organizationId, bytes: terms.sharedSpaceBytes };
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
    // ponytail: sums every file row of the organization on each write; keep a running total per
    // organization when one holds enough files for this to show.
    const [row] = await tx.$queryRaw<Array<{ used: string }>>(Prisma.sql`
      SELECT COALESCE(SUM(a."size"), 0)::text AS "used"
      FROM "artifacts" a JOIN "spaces" s ON s."id" = a."spaceId"
      WHERE s."organizationId" = ${limit.organizationId}
    `);
    if (BigInt(row?.used ?? 0) > BigInt(limit.bytes)) throw new SharedSpaceFullError();
  });
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
