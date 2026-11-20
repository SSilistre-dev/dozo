import type { DozoModelPool } from "@rakazo/contracts";
import { canonicalPiProviderId, DOZO_MODEL_POOL_MAX } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { readModelPoolMembers, setModelPoolMember } from "@rakazo/db";
import type { PoolDeps } from "./dozo-model-pool.js";
import { livePoolConnections } from "./dozo-model-pool.js";

/**
 * The model pool as settings show and change it: one switch per provider, offered where two or
 * more of the person's connections of that provider may join a pool, the first five added.
 */

type Offer = {
  provider: string;
  offered: string[];
  others: string[];
  accounts: Map<string, string>;
};

/**
 * Each provider's connections: the ones a pool may hold, in the order added, at most five and one
 * per subscription account, with their accounts; and the rest.
 */
async function poolOffers(deps: PoolDeps, userId: string): Promise<Offer[]> {
  const connections = await deps.prisma.userModelCredential.findMany({
    where: { userId },
    select: { id: true, provider: true, secretId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const byProvider = new Map<string, typeof connections>();
  for (const connection of connections) {
    const provider = canonicalPiProviderId(connection.provider);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), connection]);
  }
  const offers: Offer[] = [];
  for (const [provider, own] of byProvider) {
    const { live, accounts } = await livePoolConnections(deps, userId, own);
    const offered = live.slice(0, DOZO_MODEL_POOL_MAX);
    const others = own.map((connection) => connection.id).filter((id) => !offered.includes(id));
    offers.push({ provider, offered, others, accounts });
  }
  return offers;
}

async function readPool(deps: PoolDeps, userId: string, offers: Offer[], now: number) {
  const shown = offers.filter((offer) => offer.offered.length >= 2);
  const members = await readModelPoolMembers(deps.prisma, {
    userId,
    credentialIds: shown.flatMap((offer) => offer.offered),
    accounts: new Map(shown.flatMap((offer) => [...offer.accounts])),
  });
  const rests = new Map(members.map((member) => [member.credentialId, member.resetsAt]));
  return {
    connections: shown.flatMap((offer) => {
      // A pool of one hands nothing over: a connection added later joins when it is turned on.
      const pooled = offer.offered.filter((id) => rests.has(id)).length >= 2;
      return offer.offered.map((credentialId) => {
        const resetsAt = rests.get(credentialId);
        const inPool = pooled && resetsAt !== undefined;
        return {
          credentialId,
          pooled: inPool,
          ...(inPool && resetsAt && resetsAt.getTime() > now
            ? { opensAt: resetsAt.toISOString() }
            : {}),
        };
      });
    }),
  } satisfies DozoModelPool;
}

/** The person's pool as settings show it. */
export async function readDozoModelPool(
  deps: PoolDeps,
  userId: string,
  now = Date.now(),
): Promise<DozoModelPool> {
  return readPool(deps, userId, await poolOffers(deps, userId), now);
}

/**
 * Pools every connection offered beside `credentialId`, or takes its provider's connections out.
 * A connection that is not the person's, or offers no pool, is refused.
 */
export async function setDozoModelPool(
  deps: PoolDeps,
  userId: string,
  input: { credentialId: string; pooled: boolean },
  now = Date.now(),
): Promise<{ pool: DozoModelPool; provider: string }> {
  const offers = await poolOffers(deps, userId);
  const offer = offers.find((entry) => entry.offered.includes(input.credentialId));
  if (!offer || offer.offered.length < 2) {
    const known = offers.some((entry) =>
      [...entry.offered, ...entry.others].includes(input.credentialId),
    );
    throw known
      ? new ClientError("BAD_REQUEST", "This connection can't hand over to another.")
      : new ClientError("NOT_FOUND", "Connection not found.");
  }
  await deps.prisma.$transaction(async (tx) => {
    for (const credentialId of offer.offered)
      await setModelPoolMember(tx, { userId, credentialId }, input.pooled);
    for (const credentialId of offer.others)
      await setModelPoolMember(tx, { userId, credentialId }, false);
  });
  return { pool: await readPool(deps, userId, offers, now), provider: offer.provider };
}
