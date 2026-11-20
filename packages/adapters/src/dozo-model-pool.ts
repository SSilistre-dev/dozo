import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  isModelCredentialRejected,
  isRetryableProviderUnavailable,
  isTransientModelError,
} from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { providerQuotaResetAt } from "@rakazo/contracts";
import type { PoolCooldownReason } from "@rakazo/core";
import { poolCooldownUntil, poolOrder } from "@rakazo/core";
import {
  findModelCredentialById,
  modelCredentialProviderFilter,
  readModelPool,
  recordModelConnectionCooldown,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { POOLABLE_CONNECTION_KINDS } from "./dozo-model-pool-capabilities.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { ModelCredential } from "./model-selection.js";
import { loadStoredModelSecret } from "./model-selection.js";
import { modelCredentialAuthKindFromPlaintext } from "./pi-catalog-availability.js";

/**
 * A run's model pool (packages/core/src/dozo-model-pool.ts): the connection it starts on and the
 * other open ones of the same provider it may move to when that one runs out. Without a pooled
 * connection a run has none, and everything here leaves it as it was.
 */
export interface RunModelPool {
  provider: string;
  modelId: string;
  /** The connection the run starts on. */
  credential: NonNullable<ModelCredential>;
  /** The other open connections, in the order the run moves to them. */
  members: string[];
  /** Set when every connection rests: when the first opens again. */
  opensAt?: number;
  /** Rests a connection that ran out, until the provider's reset or the default time. */
  recordOut(
    connectionId: string,
    modelId: string,
    reason: PoolCooldownReason,
    providerResetAt?: number,
  ): Promise<unknown>;
}

export type PoolDeps = Pick<ExecutorDeps, "prisma" | "secretStore">;
type PoolRun = { userId: string; modelPinned: boolean };
type SelectedModel = {
  provider?: string | null;
  id?: string | null;
  credential: ModelCredential;
};

/**
 * The pool of the run's selected connection, read once when the run starts. None for a pinned run
 * (it keeps the connection it asked for), the deployment's model, or a connection not pooled. A
 * pool that cannot be read is none either: the run starts on its chosen connection as before.
 */
export async function loadRunModelPool(
  deps: PoolDeps,
  run: PoolRun,
  selected: SelectedModel,
  now = Date.now(),
): Promise<RunModelPool | undefined> {
  const { credential, provider, id: modelId } = selected;
  if (run.modelPinned || !credential || !provider || !modelId) return undefined;
  return bestEffort(
    "model pool read",
    readRunModelPool(deps, run, { credential, provider, modelId }, now),
  );
}

async function readRunModelPool(
  deps: PoolDeps,
  run: PoolRun,
  selected: { credential: NonNullable<ModelCredential>; provider: string; modelId: string },
  now: number,
): Promise<RunModelPool | undefined> {
  const { credential, provider, modelId } = selected;
  const { prisma } = deps;
  const scope = { userId: run.userId, modelId };
  if (!(await readModelPool(prisma, { ...scope, credentialIds: [credential.id] })).length)
    return undefined;
  const connections = await prisma.userModelCredential.findMany({
    where: { userId: run.userId, provider: modelCredentialProviderFilter(provider) },
    select: { id: true, secretId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const stored = await readModelPool(prisma, {
    ...scope,
    credentialIds: connections.map((connection) => connection.id),
  });
  const members = [];
  for (const connection of connections) {
    const member = stored.find((row) => row.credentialId === connection.id);
    if (!member || !(await poolable(deps, run.userId, connection.secretId))) continue;
    members.push({ id: connection.id, resetsAt: member.resetsAt?.getTime() });
  }
  if (members.length < 2 || !members.some((member) => member.id === credential.id))
    return undefined;
  const { order, opensAt } = poolOrder({ members, preferred: credential.id, now });
  const startId = order[0] ?? credential.id;
  const start =
    startId === credential.id
      ? credential
      : ((await findModelCredentialById(prisma, run, startId, provider)) ?? credential);
  if (start.id !== credential.id)
    getLogger().info("model.pool.moved", { "model.provider": provider, "model.id": modelId });
  return {
    provider,
    modelId,
    credential: start,
    // Every connection rests: the run tries the one that opens first, and moves to no other.
    members: opensAt === undefined ? order.filter((member) => member !== start.id) : [],
    ...(opensAt === undefined ? {} : { opensAt }),
    recordOut: (connectionId, failedModelId, reason, providerResetAt) => {
      const observedAt = Date.now();
      return recordModelConnectionCooldown(prisma, {
        userId: run.userId,
        credentialId: connectionId,
        modelId: reason === "rejected" ? null : failedModelId,
        reason,
        resetsAt: new Date(poolCooldownUntil(observedAt, providerResetAt)),
        observedAt: new Date(observedAt),
      });
    },
  };
}

/** Whether a stored connection is of a kind that may join a pool; one that cannot be read is not. */
export async function poolable(deps: PoolDeps, userId: string, secretId: string): Promise<boolean> {
  const secret = await loadStoredModelSecret(deps.prisma, deps.secretStore, userId, secretId);
  if (secret.status !== "loaded") return false;
  try {
    return POOLABLE_CONNECTION_KINDS[modelCredentialAuthKindFromPlaintext(secret.plaintext)];
  } catch {
    return false;
  }
}

/**
 * The run's backups with the pool's other open connections first, on the same model. Only when
 * the run started on the pool's connection: a run that started on a backup keeps the backups.
 */
export function withPoolMembers(
  pool: RunModelPool | undefined,
  running: { provider: string; modelId: string; connectionId?: string },
  thinkingLevel: ModelRoleChoice["thinkingLevel"],
  backups: ModelRoleChoice[],
): ModelRoleChoice[] {
  if (
    !pool?.members.length ||
    running.provider !== pool.provider ||
    running.modelId !== pool.modelId ||
    running.connectionId !== pool.credential.id
  )
    return backups;
  const members = new Set(pool.members);
  const repeated = (backup: ModelRoleChoice) =>
    backup.provider === pool.provider &&
    backup.modelId === pool.modelId &&
    backup.credentialId !== undefined &&
    members.has(backup.credentialId);
  return [
    ...pool.members.map((credentialId) => ({
      provider: pool.provider,
      modelId: pool.modelId,
      credentialId,
      thinkingLevel,
    })),
    ...backups.filter((backup) => !repeated(backup)),
  ];
}

const runPools = new WeakMap<AgentRunRequest, RunModelPool>();
/** Fallback streams whose current move to a backup follows a connection that ran out. */
const movingOut = new WeakSet<object>();
/** Per fallback stream, the first place in its backup chain where a pool connection was passed over. */
const passedOver = new WeakMap<object, number>();

/** The part of the runtime's fallback stream state the pool reads and moves. */
type FallbackState = { request: AgentRunRequest; nextIndex: number };

/** Hands the run's pool to the model runtime with its request. */
export function withRunModelPool(
  request: AgentRunRequest,
  pool: RunModelPool | undefined,
): AgentRunRequest {
  if (pool) runPools.set(request, pool);
  return request;
}

/** Words or a status with which a provider says the account's quota or credit is spent. */
const SPENT =
  /insufficient_quota|exceeded your current quota|quota (?:exceeded|exhausted)|usage limit|credit balance|insufficient (?:funds|balance|credits?)|out of (?:budget|credits?)|add more credits|\b40[023]\b/i;

/**
 * Whether a failure means the connection ran out: its quota or credit is spent, or its key was
 * refused. A short rate limit, an overload or a dropped connection is not: those retry as before.
 * A limit that does not say it is spent, and gives no reset hours away, counts as short.
 */
export function connectionOutReason(error: {
  errorMessage?: string;
}): PoolCooldownReason | undefined {
  if (isModelCredentialRejected(error)) return "rejected";
  if (!isRetryableProviderUnavailable(error) || isTransientModelError(error)) return undefined;
  const text = error.errorMessage ?? "";
  return providerQuotaResetAt(text) !== undefined || SPENT.test(text) ? "exhausted" : undefined;
}

/**
 * Moves a failed call to the next backup. When the connection ran out, it rests first and the
 * pool's other connections may take the call, those passed over after an earlier failure of this
 * run included; after any other failure they are passed over.
 */
export async function switchAfterFailure(
  state: FallbackState,
  failed: { id: string; connectionId?: string },
  error: AssistantMessage,
  switchToNext: () => Promise<boolean>,
): Promise<boolean> {
  const pool = runPools.get(state.request);
  const reason = pool && connectionOutReason(error);
  if (!pool || !reason) return switchToNext();
  if (failed.connectionId)
    await bestEffort(
      "model pool cooldown",
      pool.recordOut(
        failed.connectionId,
        failed.id,
        reason,
        providerQuotaResetAt(error.errorMessage ?? ""),
      ),
    );
  // Everything before that place was tried or ruled out, so the chain can go back to it.
  const from = passedOver.get(state);
  if (from !== undefined) state.nextIndex = Math.min(state.nextIndex, from);
  passedOver.delete(state);
  movingOut.add(state);
  try {
    return await switchToNext();
  } finally {
    movingOut.delete(state);
  }
}

/**
 * Whether the backup just taken from the chain (at `state.nextIndex - 1`) is one of the pool's
 * connections the current failure may not move to. It is kept for a later failure that ran out.
 */
export function skipsPoolMember(state: FallbackState, choice: { connectionId?: string }): boolean {
  const pool = runPools.get(state.request);
  if (!pool || !choice.connectionId || movingOut.has(state)) return false;
  if (!pool.members.includes(choice.connectionId)) return false;
  const index = state.nextIndex - 1;
  passedOver.set(state, Math.min(passedOver.get(state) ?? index, index));
  return true;
}
