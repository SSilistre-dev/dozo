import type { PoolCooldownReason } from "@rakazo/core";
import type { PrismaClient } from "./client.js";

/**
 * The fork's model pool tables (migration `20261231130000_dozo_model_pool`): which of a person's
 * connections are pooled, and until when one that ran out rests. Every read and write is scoped to
 * the connection's owner, so row security and the composite key agree.
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

export interface StoredPoolMember {
  credentialId: string;
  /** The end of the latest rest for this model or the whole connection; may be in the past. */
  resetsAt: Date | null;
}

/** Adds a connection to its owner's pool, or takes it out. False when the connection is not theirs. */
export async function setModelPoolMember(
  db: Db,
  owner: { userId: string; credentialId: string },
  pooled: boolean,
): Promise<boolean> {
  if (!pooled) {
    await db.$executeRaw`
      DELETE FROM "dozo_model_pool_members"
      WHERE "credentialId" = ${owner.credentialId} AND "userId" = ${owner.userId}`;
    return true;
  }
  const added = await db.$executeRaw`
    INSERT INTO "dozo_model_pool_members" ("credentialId", "userId")
    SELECT c."id", c."userId" FROM "user_model_credentials" c
    WHERE c."id" = ${owner.credentialId} AND c."userId" = ${owner.userId}
    ON CONFLICT ("credentialId") DO NOTHING`;
  if (added) return true;
  const [row] = await db.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "dozo_model_pool_members"
      WHERE "credentialId" = ${owner.credentialId} AND "userId" = ${owner.userId}
    ) AS found`;
  return Boolean(row?.found);
}

/**
 * Which of `credentialIds` are pooled, each with its latest rest for `modelId`. A rest recorded
 * for an earlier secret of the connection is left out: saving a new key ends it.
 */
export async function readModelPool(
  db: Db,
  scope: { userId: string; credentialIds: readonly string[]; modelId: string },
): Promise<StoredPoolMember[]> {
  if (!scope.credentialIds.length) return [];
  return db.$queryRaw<StoredPoolMember[]>`
    SELECT m."credentialId", max(cd."resetsAt") AS "resetsAt"
    FROM "dozo_model_pool_members" m
    JOIN "user_model_credentials" c ON c."id" = m."credentialId" AND c."userId" = m."userId"
    LEFT JOIN "dozo_model_connection_cooldowns" cd
      ON cd."credentialId" = m."credentialId"
      AND cd."modelId" IN ('', ${scope.modelId})
      AND cd."secretId" = c."secretId"
    WHERE m."userId" = ${scope.userId} AND m."credentialId" = ANY(${[...scope.credentialIds]})
    GROUP BY m."credentialId"`;
}

/**
 * Records that a pooled connection ran out. Nothing is written for a connection that is not pooled.
 * Two runs that see the same failure race safely: the newest observation wins.
 */
export async function recordModelConnectionCooldown(
  db: Db,
  rest: {
    userId: string;
    credentialId: string;
    /** Null when the whole connection rests (a refused key). */
    modelId: string | null;
    reason: PoolCooldownReason;
    resetsAt: Date;
    observedAt: Date;
  },
): Promise<boolean> {
  const written = await db.$executeRaw`
    INSERT INTO "dozo_model_connection_cooldowns"
      ("credentialId", "userId", "modelId", "secretId", "reason", "resetsAt", "observedAt")
    SELECT m."credentialId", m."userId", ${rest.modelId ?? ""}, c."secretId", ${rest.reason},
      ${rest.resetsAt}, ${rest.observedAt}
    FROM "dozo_model_pool_members" m
    JOIN "user_model_credentials" c ON c."id" = m."credentialId" AND c."userId" = m."userId"
    WHERE m."credentialId" = ${rest.credentialId} AND m."userId" = ${rest.userId}
    ON CONFLICT ("credentialId", "modelId") DO UPDATE SET
      "secretId" = EXCLUDED."secretId",
      "reason" = EXCLUDED."reason",
      "resetsAt" = EXCLUDED."resetsAt",
      "observedAt" = EXCLUDED."observedAt"
    WHERE "dozo_model_connection_cooldowns"."observedAt" <= EXCLUDED."observedAt"`;
  return written > 0;
}
