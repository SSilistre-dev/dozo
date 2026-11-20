/**
 * A pool is one person's own connections to the same provider that stand in for each other. When
 * one runs out of quota or credit, or its key is refused, the run moves to the next and the one that
 * ran out rests until it resets. It is a handover, not a way around rate limits: a run stays on one
 * connection and never spreads its calls across them.
 */

/** How long a connection rests when the provider gave no reset time. */
export const POOL_COOLDOWN_DEFAULT_MS = 60 * 60_000;
/** A reset further away than this is held to it, so a misread date cannot shut a connection for good. */
export const POOL_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60_000;

/** Why a connection rests: its quota or credit ran out, or the provider refused its key. */
export type PoolCooldownReason = "exhausted" | "rejected";

export interface PoolMember {
  id: string;
  /** When its last rest ends or ended, in epoch milliseconds; absent when it never rested. */
  resetsAt?: number;
}

export interface PoolOrder {
  /** Connections to run on, the first one first. */
  order: string[];
  /** Set when every connection rests: the earliest moment one opens again. */
  opensAt?: number;
}

/**
 * The order a run tries a pool in. `members` come in the order they were added; `preferred` is the
 * connection the person chose. The chosen one goes first while it is open, then the other open ones
 * in the order they were added; a resting one is left out until its reset passes. When every one
 * rests, all are returned, the one that opens first first, with that moment as `opensAt`.
 */
export function poolOrder(input: {
  members: readonly PoolMember[];
  preferred: string;
  now: number;
}): PoolOrder {
  const resting = (member: PoolMember): member is Required<PoolMember> =>
    member.resetsAt !== undefined && member.resetsAt > input.now;
  const open = input.members.filter((member) => !resting(member));
  if (open.length) {
    const preferred = open.filter((member) => member.id === input.preferred);
    const others = open.filter((member) => member.id !== input.preferred);
    return { order: [...preferred, ...others].map((member) => member.id) };
  }
  const byReset = input.members.filter(resting).sort((a, b) => a.resetsAt - b.resetsAt);
  return { order: byReset.map((member) => member.id), opensAt: byReset[0]?.resetsAt };
}

/** When a connection that just ran out opens again: the provider's reset, else the default rest. */
export function poolCooldownUntil(now: number, providerResetAt?: number): number {
  if (providerResetAt === undefined || providerResetAt <= now)
    return now + POOL_COOLDOWN_DEFAULT_MS;
  return Math.min(providerResetAt, now + POOL_COOLDOWN_MAX_MS);
}
