import type { PoolCooldownReason } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/**
 * The fork's model pool tables (migration `20261231130000_dozo_model_pool`): which of a person's
 * connections are pooled, and until when one that ran out rests. Every read and write is scoped to
 * the connection's owner, so row security and the composite key agree.
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/**
 * The end of a rest being recorded over the one before it. A key refused again on the same
 * secret, within a day of its last rest ending, rests twice as long as last time, up to seven
 * days: one refusal that was a provider's mistake costs minutes, a key that stays refused soon
 * costs nothing. Any other rest ends when its caller says.
 */
const REFUSED_AGAIN = Prisma.sql`CASE
  WHEN EXCLUDED."reason" = 'rejected'
    AND "dozo_model_connection_cooldowns"."reason" = 'rejected'
    AND "dozo_model_connection_cooldowns"."secretId" = EXCLUDED."secretId"
    AND "dozo_model_connection_cooldowns"."resetsAt" > EXCLUDED."observedAt" - interval '24 hours'
  THEN GREATEST(
    EXCLUDED."resetsAt",
    LEAST(
      EXCLUDED."observedAt" + 2 * ("dozo_model_connection_cooldowns"."resetsAt"
        - "dozo_model_connection_cooldowns"."observedAt"),
      EXCLUDED."observedAt" + interval '168 hours'
    )
  )
  ELSE EXCLUDED."resetsAt"
END`;

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
 * The current holder of each connection a rest may belong to: its subscription account, when the
 * caller knows one (see `holder` on a rest), else nothing beyond its secret.
 */
export type PoolAccounts = ReadonlyMap<string, string>;

/** `credentialIds` paired with their accounts, '' for none, for an `unnest` join. */
function accountColumns(credentialIds: readonly string[], accounts?: PoolAccounts) {
  return { ids: [...credentialIds], keys: credentialIds.map((id) => accounts?.get(id) ?? "") };
}

/**
 * Which of `credentialIds` are pooled, each with its latest rest for `modelId`. A rest belongs to
 * the secret the connection had when it ran out, so saving a new key ends it; one recorded for a
 * subscription account (`holder`) belongs to that account instead, which a token refresh or a new
 * sign-in with the same account keeps.
 */
export async function readModelPool(
  db: Db,
  scope: {
    userId: string;
    credentialIds: readonly string[];
    modelId: string;
    accounts?: PoolAccounts;
  },
): Promise<StoredPoolMember[]> {
  if (!scope.credentialIds.length) return [];
  const { ids, keys } = accountColumns(scope.credentialIds, scope.accounts);
  return db.$queryRaw<StoredPoolMember[]>`
    SELECT m."credentialId", max(cd."resetsAt") AT TIME ZONE 'UTC' AS "resetsAt"
    FROM "dozo_model_pool_members" m
    JOIN "user_model_credentials" c ON c."id" = m."credentialId" AND c."userId" = m."userId"
    JOIN unnest(${ids}::text[], ${keys}::text[]) AS a("id", "account") ON a."id" = m."credentialId"
    LEFT JOIN "dozo_model_connection_cooldowns" cd
      ON cd."credentialId" = m."credentialId"
      AND cd."modelId" IN ('', ${scope.modelId})
      AND (cd."holder" IS NULL AND cd."secretId" = c."secretId" OR cd."holder" = a."account")
    WHERE m."userId" = ${scope.userId}
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
    /** The subscription account the rest belongs to; absent: the connection's current secret. */
    holder?: string;
  },
): Promise<boolean> {
  const written = await db.$executeRaw`
    INSERT INTO "dozo_model_connection_cooldowns"
      ("credentialId", "userId", "modelId", "secretId", "holder", "reason", "resetsAt", "observedAt")
    SELECT m."credentialId", m."userId", ${rest.modelId ?? ""}, c."secretId", ${rest.holder ?? null},
      ${rest.reason}, ${rest.resetsAt.toISOString()}::timestamptz,
      ${rest.observedAt.toISOString()}::timestamptz
    FROM "dozo_model_pool_members" m
    JOIN "user_model_credentials" c ON c."id" = m."credentialId" AND c."userId" = m."userId"
    WHERE m."credentialId" = ${rest.credentialId} AND m."userId" = ${rest.userId}
    ON CONFLICT ("credentialId", "modelId") DO UPDATE SET
      "secretId" = EXCLUDED."secretId",
      "holder" = EXCLUDED."holder",
      "reason" = EXCLUDED."reason",
      "resetsAt" = ${REFUSED_AGAIN},
      "observedAt" = EXCLUDED."observedAt"
    WHERE "dozo_model_connection_cooldowns"."observedAt" <= EXCLUDED."observedAt"`;
  return written > 0;
}

/**
 * Which of `credentialIds` are pooled, each with the end of its latest rest for any model, as
 * settings show it. A rest belongs to its secret or account as in `readModelPool`.
 */
export async function readModelPoolMembers(
  db: Db,
  scope: { userId: string; credentialIds: readonly string[]; accounts?: PoolAccounts },
): Promise<StoredPoolMember[]> {
  if (!scope.credentialIds.length) return [];
  const { ids, keys } = accountColumns(scope.credentialIds, scope.accounts);
  return db.$queryRaw<StoredPoolMember[]>`
    SELECT m."credentialId", max(cd."resetsAt") AT TIME ZONE 'UTC' AS "resetsAt"
    FROM "dozo_model_pool_members" m
    JOIN "user_model_credentials" c ON c."id" = m."credentialId" AND c."userId" = m."userId"
    JOIN unnest(${ids}::text[], ${keys}::text[]) AS a("id", "account") ON a."id" = m."credentialId"
    LEFT JOIN "dozo_model_connection_cooldowns" cd
      ON cd."credentialId" = m."credentialId"
      AND (cd."holder" IS NULL AND cd."secretId" = c."secretId" OR cd."holder" = a."account")
    WHERE m."userId" = ${scope.userId}
    GROUP BY m."credentialId"`;
}

/**
 * Rests outside a pool: a model, or a whole connection, that ran out on any of the person's own
 * connections, so later runs start on their next backup until it opens again. The same table as
 * the pool's: one rest per connection and model, the newest observation winning. Unlike
 * `recordModelConnectionCooldown`, the connection need not be pooled.
 */
export async function recordModelRest(
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
  // Rests that ended over a day ago say nothing any more, not even to a refused key's next
  // rest: the person's go when they get a new one, so rows do not pile up.
  await db.$executeRaw`
    DELETE FROM "dozo_model_connection_cooldowns"
    WHERE "userId" = ${rest.userId}
      AND "resetsAt" < ${rest.observedAt.toISOString()}::timestamptz - interval '24 hours'`;
  const written = await db.$executeRaw`
    INSERT INTO "dozo_model_connection_cooldowns"
      ("credentialId", "userId", "modelId", "secretId", "holder", "reason", "resetsAt", "observedAt")
    SELECT c."id", c."userId", ${rest.modelId ?? ""}, c."secretId", NULL, ${rest.reason},
      ${rest.resetsAt.toISOString()}::timestamptz, ${rest.observedAt.toISOString()}::timestamptz
    FROM "user_model_credentials" c
    WHERE c."id" = ${rest.credentialId} AND c."userId" = ${rest.userId}
    ON CONFLICT ("credentialId", "modelId") DO UPDATE SET
      "secretId" = EXCLUDED."secretId",
      "holder" = EXCLUDED."holder",
      "reason" = EXCLUDED."reason",
      "resetsAt" = ${REFUSED_AGAIN},
      "observedAt" = EXCLUDED."observedAt"
    WHERE "dozo_model_connection_cooldowns"."observedAt" <= EXCLUDED."observedAt"`;
  return written > 0;
}

/**
 * The person's rests that have not ended at `now`: each model, or with modelId '' each whole
 * connection, recorded while the connection had the secret it has now, with its latest end. One
 * read per run start, on the table's index of a person's rests by their end.
 */
export async function readActiveModelRests(
  db: Db,
  userId: string,
  now: Date,
): Promise<Array<{ credentialId: string; modelId: string; resetsAt: Date }>> {
  return db.$queryRaw`
    SELECT cd."credentialId", cd."modelId", max(cd."resetsAt") AT TIME ZONE 'UTC' AS "resetsAt"
    FROM "dozo_model_connection_cooldowns" cd
    JOIN "user_model_credentials" c ON c."id" = cd."credentialId" AND c."userId" = cd."userId"
    WHERE cd."userId" = ${userId} AND cd."resetsAt" > ${now.toISOString()}::timestamptz
      AND cd."secretId" = c."secretId"
    GROUP BY cd."credentialId", cd."modelId"`;
}

/**
 * Ends every rest of a model on the person's connections of its provider, and of those whole
 * connections: they picked it again, so it is tried at once. `providers` names the stored ids
 * the provider's connections may carry.
 */
export async function endModelRests(
  db: Db,
  scope: { userId: string; providers: readonly string[]; modelId: string },
): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "dozo_model_connection_cooldowns" cd
    USING "user_model_credentials" c
    WHERE cd."credentialId" = c."id" AND cd."userId" = c."userId"
      AND c."userId" = ${scope.userId} AND c."provider" = ANY(${[...scope.providers]}::text[])
      AND cd."modelId" IN ('', ${scope.modelId})`;
}
