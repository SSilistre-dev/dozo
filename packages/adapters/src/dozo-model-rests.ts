import type { SecretStore } from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { storedPiProviderIds } from "@rakazo/contracts";
import type { PoolCooldownReason } from "@rakazo/core";
import { poolCooldownUntil } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { endModelRests, readActiveModelRests, recordModelRest } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { findConnectedModelCredential } from "./models/model-selection.js";

/**
 * Rests beyond the pool (packages/core/src/dozo-model-pool.ts): a model whose quota or usage
 * limit ran out on one of the person's own connections rests until the provider's reset or the
 * pool's default time, and a connection whose key was refused rests a few minutes, longer each
 * time it is refused again. A later run of theirs does not start on it: it starts on its next
 * backup, and comes back to it once the rest has passed, read against the clock when the run
 * starts. Picking the model again in settings or for a bot, or a new key, ends the rest at once. A short rate limit, an overload or a
 * dropped connection never rests a model (`connectionOutReason`). A run on the deployment's
 * model has no connection of the person's, and nothing rests.
 */

export type RestDeps = { prisma: PrismaClient; secretStore: Pick<SecretStore, "load"> };
type RestRun = { userId: string; spaceId: string; modelPinned?: boolean };

/** A model as a run chooses it: on a named connection, or on the one the run would resolve. */
type Choice = { provider: string; modelId: string; credentialId?: string };
type ActiveRest = { credentialId: string; modelId: string; resetsAt: Date };

const restKey = (credentialId: string, modelId: string) => JSON.stringify([credentialId, modelId]);

/** One read of the person's rests per run, shared by its start and its backup order. */
const runRests = new WeakMap<object, Promise<ActiveRest[] | undefined>>();

function activeRests(deps: RestDeps, run: RestRun, now: number) {
  let rests = runRests.get(run);
  if (!rests) {
    rests = bestEffort(
      "model rests read",
      readActiveModelRests(deps.prisma, run.userId, new Date(now)),
    );
    runRests.set(run, rests);
  }
  return rests;
}

/** Which of `choices` rest at `now`, by position, on the connection the run resolves for each. */
async function resting(
  deps: RestDeps,
  run: RestRun,
  choices: readonly Choice[],
  now: number,
): Promise<boolean[]> {
  const rests = (await activeRests(deps, run, now)) ?? [];
  const ends = new Map(
    rests.map((rest) => [restKey(rest.credentialId, rest.modelId), new Date(rest.resetsAt)]),
  );
  if (!ends.size) return choices.map(() => false);
  return Promise.all(
    choices.map(async (choice) => {
      // The same resolution a run uses, so a rest is read on the connection the run would use.
      const connection = await bestEffort(
        "model rest connection",
        findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          run,
          choice.provider,
          choice.modelId,
          { credentialId: choice.credentialId },
        ),
      );
      if (!connection) return false;
      return [choice.modelId, ""].some(
        (modelId) => (ends.get(restKey(connection.id, modelId))?.getTime() ?? 0) > now,
      );
    }),
  );
}

/**
 * The run's backups in their order with the resting ones moved to the end, so a run reaches a
 * resting one only after every other. A rest that cannot be read leaves the order as it was.
 */
export async function backupsPastRests<Role extends { backups: ModelRoleChoice[] }>(
  deps: RestDeps,
  run: RestRun,
  role: Role,
  now = Date.now(),
): Promise<Role> {
  const { backups } = role;
  if (!backups.length) return role;
  const flags = await resting(deps, run, backups, now);
  if (!flags.some(Boolean)) return role;
  return {
    ...role,
    backups: [...backups.filter((_, i) => !flags[i]), ...backups.filter((_, i) => flags[i])],
  };
}

/**
 * The backup a run starts on because the model it chose rests, else nothing: the run then starts
 * on its chosen model as before. A run that keeps its model (a routine's, a retry, a helper's)
 * starts on it and leaves the rest as it is. One on the deployment's model, or on a computer's
 * saved models, never skips.
 */
export async function startPastRest<Start>(
  deps: RestDeps,
  run: RestRun,
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
  const [rests] = await resting(deps, run, [choice], now);
  if (!rests) return undefined;
  // A pinned run keeps its model.
  if (run.modelPinned) return undefined;
  const start = await startOnBackup();
  if (start)
    getLogger().info("model.rest.skipped", {
      "model.provider": selected.provider,
      "model.id": selected.id,
    });
  return start;
}

/**
 * Records that a model, or with "rejected" its whole connection, ran out. Never fails; the switch
 * to a backup does not wait for it, so a slow database never holds up the call.
 */
export function recordRest(
  prisma: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
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
      resetsAt: new Date(poolCooldownUntil(observedAt, providerResetAt, reason)),
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
