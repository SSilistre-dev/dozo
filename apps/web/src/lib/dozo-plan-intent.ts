import type { ByokInterval, ByokTier } from "@rakazo/contracts";

/**
 * A paid plan picked on the landing page before the visitor has an account. Its links to sign-up
 * carry `?plan=premium|premium_plus&period=month|year`; the sign-up page keeps the pick in session
 * storage for this tab, and once the app opens Billing offers it, preselected. Free, or anything
 * that is not one of these values, is no pick. Prices are never read from here: the server prices
 * the tier and period it is sent.
 *
 * A pick lasts an hour and belongs to the first account that opens the app with it (`userId`,
 * set by `bindPlanIntent`); signing out forgets it, so another account in the same tab never
 * inherits it.
 */
export type PlanIntent = { tier: ByokTier; period: ByokInterval };
type StoredIntent = PlanIntent & { savedAt: number; userId?: string };

const KEY = "dozo:plan-intent";
export const PLAN_INTENT_TTL_MS = 60 * 60 * 1000;
const PLANS: Record<string, ByokTier> = { premium: "pro", premium_plus: "max" };
const PERIODS: readonly ByokInterval[] = ["month", "year"];

/** The pick the address names; a missing or unknown period is monthly. */
export function planIntentFromParams(
  plan: string | null,
  period: string | null,
): PlanIntent | null {
  const tier = plan !== null && Object.hasOwn(PLANS, plan) ? PLANS[plan] : undefined;
  if (!tier) return null;
  return { tier, period: PERIODS.find((value) => value === period) ?? "month" };
}

function storage(): Storage | null {
  // Storage can be switched off, or refuse access, in a private window; then there is no pick.
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function write(value: StoredIntent): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(value));
  } catch {
    // A full or refused store keeps no pick; sign-up goes on as without one.
  }
}

/** Keeps a new pick, for whichever account opens the app next. */
export function savePlanIntent(intent: PlanIntent): void {
  write({ tier: intent.tier, period: intent.period, savedAt: Date.now() });
}

/** The kept pick, checked again, since anything in this tab can write the store. */
function readStored(): StoredIntent | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { tier, period, savedAt, userId } = value as Record<string, unknown>;
    const plan = Object.keys(PLANS).find((name) => PLANS[name] === tier) ?? null;
    const intent = planIntentFromParams(plan, typeof period === "string" ? period : null);
    if (!intent || intent.period !== period) return null;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
    if (userId !== undefined && typeof userId !== "string") return null;
    const age = Date.now() - savedAt;
    if (age < 0 || age > PLAN_INTENT_TTL_MS) return null;
    return { ...intent, savedAt, ...(userId === undefined ? {} : { userId }) };
  } catch {
    return null;
  }
}

/** The pick still in force: under an hour old and not another account's. */
export function readPlanIntent(userId?: string): PlanIntent | null {
  const stored = readStored();
  if (!stored) return null;
  if (stored.userId !== undefined && userId !== undefined && stored.userId !== userId) return null;
  return { tier: stored.tier, period: stored.period };
}

/**
 * Gives an unclaimed pick to `userId` and returns it; drops a pick that is stale, malformed or
 * another account's, and returns null.
 */
export function bindPlanIntent(userId: string): PlanIntent | null {
  const stored = readStored();
  if (!stored || (stored.userId !== undefined && stored.userId !== userId)) {
    clearPlanIntent();
    return null;
  }
  if (stored.userId === undefined) write({ ...stored, userId });
  return { tier: stored.tier, period: stored.period };
}

export function clearPlanIntent(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing kept that can be removed.
  }
}
