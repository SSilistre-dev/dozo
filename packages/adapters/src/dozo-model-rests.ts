import type { ModelRoleChoice } from "@rakazo/contracts";
import { storedPiProviderIds } from "@rakazo/contracts";
import type { PoolCooldownReason } from "@rakazo/core";
import { poolCooldownUntil } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  endModelRests,
  findModelCredential,
  hasModelRests,
  readModelRests,
  recordModelRest,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

/**
 * Rests beyond the pool (packages/core/src/dozo-model-pool.ts): a model whose quota or usage
 * limit ran out on one of the person's own connections, or a connection whose key was refused,
 * rests until the provider's reset or the pool's default time. A later run of theirs does not
 * start on it: it starts on its next backup, and comes back to it once the rest has passed, read
 * against the clock when the run starts. Picking the model again ends the rest at once. A short
 * rate limit, an overload or a dropped connection never rests a model (`connectionOutReason`).
 * A run on the deployment's model has no connection of the person's, and nothing rests.
 */

type Db = Pick<
  PrismaClient,
  "$queryRaw" | "$executeRaw" | "userModelCredential" | "userModelPreference"
>;

/** A model as a run chooses it: on a named connection, or on the provider's own choice of one. */
type Choice = { provider: string; modelId: string; credentialId?: string };

const restKey = (credentialId: string, modelId: string) => JSON.stringify([credentialId, modelId]);

/** The connection each choice runs on, as the run resolves one that names none. */
async function connectionsOf(prisma: Db, userId: string, choices: readonly Choice[]) {
  return Promise.all(
    choices.map(
      async (choice) =>
        choice.credentialId ??
        (await findModelCredential(prisma, { userId }, choice.provider, choice.modelId))?.id,
    ),
  );
}

/** Which of `choices` rest at `now`, by position. */
async function resting(
  prisma: Db,
  userId: string,
  choices: readonly Choice[],
  now: number,
): Promise<boolean[]> {
  if (!(await hasModelRests(prisma, userId, new Date(now)))) return choices.map(() => false);
  const connections = await connectionsOf(prisma, userId, choices);
  const models = choices.flatMap((choice, index) => {
    const credentialId = connections[index];
    return credentialId ? [{ credentialId, modelId: choice.modelId }] : [];
  });
  const rests = new Map(
    (await readModelRests(prisma, { userId, models })).map((rest) => [
      restKey(rest.credentialId, rest.modelId),
      new Date(rest.resetsAt).getTime(),
    ]),
  );
  return choices.map((choice, index) => {
    const credentialId = connections[index];
    const until = credentialId ? rests.get(restKey(credentialId, choice.modelId)) : undefined;
    return until !== undefined && until > now;
  });
}

/**
 * The backups in their order with the resting ones moved to the end, so a run reaches a resting
 * one only after every other. A rest that cannot be read leaves the order as it was.
 */
export async function backupsPastRests<T extends ModelRoleChoice>(
  prisma: Db,
  userId: string,
  backups: T[],
  now = Date.now(),
): Promise<T[]> {
  if (!backups.length) return backups;
  const flags = await bestEffort("model rests read", resting(prisma, userId, backups, now));
  if (!flags?.some(Boolean)) return backups;
  return [...backups.filter((_, index) => !flags[index]), ...backups.filter((_, i) => flags[i])];
}

/**
 * The backup a run starts on because the model it chose rests, else nothing: the run then starts
 * on its chosen model as before. A run that asked for its model for this message (pinned) ends
 * the rest instead, as picking the model again does. One on the deployment's model, or on a
 * computer's saved models, never skips.
 */
export async function startPastRest<Start>(
  prisma: Db,
  run: { userId: string; modelPinned?: boolean },
  selected: { provider: string; id: string; credential: { id: string } | null },
  restored: unknown,
  startOnBackup: () => Promise<Start | undefined>,
  now = Date.now(),
): Promise<Start | undefined> {
  if (restored || !selected.credential) return undefined;
  const choice = {
    provider: selected.provider,
    modelId: selected.id,
    credentialId: selected.credential.id,
  };
  const [rests] =
    (await bestEffort("model rests read", resting(prisma, run.userId, [choice], now))) ?? [];
  if (!rests) return undefined;
  if (run.modelPinned) {
    await modelPicked(prisma, run.userId, choice);
    return undefined;
  }
  const start = await startOnBackup();
  if (start)
    getLogger().info("model.rest.skipped", {
      "model.provider": selected.provider,
      "model.id": selected.id,
    });
  return start;
}

/** Records that a model, or with "rejected" its whole connection, ran out. */
export function recordRest(
  prisma: Db,
  userId: string,
  failed: { connectionId: string; modelId: string },
  reason: PoolCooldownReason,
  providerResetAt?: number,
) {
  const observedAt = Date.now();
  return bestEffort(
    "model rest record",
    recordModelRest(prisma, {
      userId,
      credentialId: failed.connectionId,
      modelId: reason === "rejected" ? null : failed.modelId,
      reason,
      resetsAt: new Date(poolCooldownUntil(observedAt, providerResetAt)),
      observedAt: new Date(observedAt),
    }),
  );
}

/** Ends the rests of a model the person picked again, on every connection of its provider. */
export function modelPicked(
  prisma: Pick<PrismaClient, "$queryRaw" | "$executeRaw">,
  userId: string,
  picked: { provider: string; modelId: string } | null | undefined,
) {
  if (!picked?.provider || !picked.modelId) return Promise.resolve(undefined);
  return bestEffort(
    "model rests end",
    endModelRests(prisma, {
      userId,
      providers: storedPiProviderIds(picked.provider),
      modelId: picked.modelId,
    }),
  );
}
