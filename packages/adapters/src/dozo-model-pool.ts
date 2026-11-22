import { createHash } from "node:crypto";
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
import { recordRest } from "./dozo-model-rests.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { parseModelSecret } from "./model-secret.js";
import type { ModelCredential } from "./model-selection.js";
import { loadStoredModelSecret } from "./model-selection.js";
import { modelCredentialAuthKindFromPlaintext } from "./pi-catalog-availability.js";
import { oauthCredentialAccountId } from "./pi-oauth.js";

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
  const pooled = new Set(
    (
      await readModelPool(prisma, {
        ...scope,
        credentialIds: connections.map((connection) => connection.id),
      })
    ).map((row) => row.credentialId),
  );
  const { live, accounts } = await livePoolConnections(
    deps,
    run.userId,
    connections.filter((connection) => pooled.has(connection.id)),
  );
  const rests = new Map(
    (await readModelPool(prisma, { ...scope, credentialIds: live, accounts })).map((row) => [
      row.credentialId,
      row.resetsAt?.getTime(),
    ]),
  );
  const members = live.map((id) => ({ id, resetsAt: rests.get(id) }));
  // A pool needs another connection to hand over to. The chosen one may be out of it (a sign-in
  // that must be made again): then the run starts on the pool's first open connection.
  const chosenLive = live.includes(credential.id);
  if (members.length < (chosenLive ? 2 : 1)) return undefined;
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
      // A subscription that ran out rests for its account; a refused sign-in ends with a new one.
      const holder = reason === "exhausted" ? accounts.get(connectionId) : undefined;
      return recordModelConnectionCooldown(prisma, {
        userId: run.userId,
        credentialId: connectionId,
        modelId: reason === "rejected" ? null : failedModelId,
        reason,
        ...(holder ? { holder } : {}),
        resetsAt: new Date(poolCooldownUntil(observedAt, providerResetAt, reason)),
        observedAt: new Date(observedAt),
      });
    },
  };
}

/**
 * A stored connection as a pool sees it: absent when it may not join (its kind, a secret that
 * cannot be read, a sign-in that must be made again). `account` stands for a subscription
 * sign-in's account, a digest of the provider's account id, when the provider gives one.
 */
export async function poolConnection(
  deps: PoolDeps,
  userId: string,
  secretId: string,
): Promise<{ account?: string } | undefined> {
  const secret = await loadStoredModelSecret(deps.prisma, deps.secretStore, userId, secretId);
  if (secret.status !== "loaded") return undefined;
  try {
    if (!POOLABLE_CONNECTION_KINDS[modelCredentialAuthKindFromPlaintext(secret.plaintext)])
      return undefined;
    const parsed = parseModelSecret(secret.plaintext);
    if (parsed.kind !== "oauth") return {};
    if (parsed.reconnectRequired) return undefined;
    const accountId = oauthCredentialAccountId(parsed.credential);
    if (!accountId) return {};
    return {
      account: `account:${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}`,
    };
  } catch {
    return undefined;
  }
}

/**
 * The connections, in the order given, that may stand in for each other: each one a pool may hold,
 * and of two signed in to the same account only the first, so one subscription is never two
 * members. With the accounts of those that have one.
 */
export async function livePoolConnections(
  deps: PoolDeps,
  userId: string,
  connections: readonly { id: string; secretId: string }[],
): Promise<{ live: string[]; accounts: Map<string, string> }> {
  const live: string[] = [];
  const accounts = new Map<string, string>();
  const seen = new Set<string>();
  for (const connection of connections) {
    const member = await poolConnection(deps, userId, connection.secretId);
    if (!member || (member.account && seen.has(member.account))) continue;
    live.push(connection.id);
    if (member.account) {
      seen.add(member.account);
      accounts.set(connection.id, member.account);
    }
  }
  return { live, accounts };
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
/** The run's owner, whose connections rest when one runs out outside a pool (dozo-model-rests.ts). */
const runOwners = new WeakMap<
  AgentRunRequest,
  { prisma: PoolDeps["prisma"]; userId: string; events?: ExecutorDeps["events"] }
>();
/** Fallback streams whose current move to a backup follows a connection that ran out. */
const movingOut = new WeakSet<object>();
/** Per fallback stream, the first place in its backup chain where a pool connection was passed over. */
const passedOver = new WeakMap<object, number>();

/** The part of the runtime's fallback stream state the pool reads and moves. */
type FallbackState = { request: AgentRunRequest; nextIndex: number };

/** Hands the run's pool, and whose connections rest, to the model runtime with its request. */
export function withRunModelPool(
  request: AgentRunRequest,
  pool: RunModelPool | undefined,
  owner?: {
    deps: { prisma: PoolDeps["prisma"]; events?: ExecutorDeps["events"] };
    run: { userId: string };
  },
): AgentRunRequest {
  if (pool) runPools.set(request, pool);
  if (owner)
    runOwners.set(request, {
      prisma: owner.deps.prisma,
      userId: owner.run.userId,
      events: owner.deps.events,
    });
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

/** "Try again in ~90 min." or "in 2 hours": how a subscription's window says when it resets. */
const TRY_AGAIN_IN = /\btry again in ~?\s*(\d+(?:\.\d+)?)\s*(min|minutes?|hours?|hrs?|h|days?)\b/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/**
 * When a connection that ran out opens again, as the provider says it: its reset headers, else the
 * time a subscription's usage window names in words. Nothing when it says neither.
 */
export function poolResetAt(text: string, now = Date.now()): number | undefined {
  const fromHeaders = providerQuotaResetAt(text, now);
  if (fromHeaders !== undefined) return fromHeaders;
  const match = TRY_AGAIN_IN.exec(text);
  if (!match) return undefined;
  return now + Number(match[1]) * (UNIT_MS[(match[2] ?? "m").charAt(0).toLowerCase()] ?? 0);
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
  const reason = connectionOutReason(error);
  const owner = runOwners.get(state.request);
  const pooled =
    pool &&
    failed.connectionId &&
    (failed.connectionId === pool.credential.id || pool.members.includes(failed.connectionId));
  // A connection outside the run's pool rests on its own, so later runs start past it. The
  // switch does not wait for the record (it never fails); the person's apps hear of it after.
  if (reason && owner && failed.connectionId && !pooled)
    void recordRest(
      owner.prisma,
      owner.userId,
      { connectionId: failed.connectionId, modelId: failed.id },
      reason,
      poolResetAt(error.errorMessage ?? ""),
    ).then(() => owner.events?.publishRosterChange?.({ userIds: [owner.userId] }));
  if (!pool || !reason) return switchToNext();
  if (failed.connectionId)
    await bestEffort(
      "model pool cooldown",
      pool.recordOut(failed.connectionId, failed.id, reason, poolResetAt(error.errorMessage ?? "")),
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
