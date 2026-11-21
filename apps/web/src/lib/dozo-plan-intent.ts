import type { ByokInterval, ByokTier } from "@rakazo/contracts";
import { forgetKept, KEPT_FOR_MS, keepForAnHour, readKept } from "./dozo-kept-for-an-hour";

/**
 * A paid plan picked on the landing page before the visitor has an account. Its links to sign-up
 * carry `?plan=premium|premium_plus&period=month|year`; the sign-up page keeps the pick in this
 * browser (`dozo-kept-for-an-hour`), so the tab the confirmation mail opens has it too, and once the
 * app opens Billing offers it, preselected. Free, or anything that is not one of these values, is
 * no pick. Prices are never read from here: the server prices the tier and period it is sent.
 *
 * A pick lasts an hour and belongs to the first account that opens the app with it (`userId`,
 * set by `bindPlanIntent`); another account in the same browser never inherits it.
 */
export type PlanIntent = { tier: ByokTier; period: ByokInterval };
type StoredIntent = PlanIntent & { expiresAt: number; userId?: string };

const KEY = "dozo:plan-intent";
export const PLAN_INTENT_TTL_MS = KEPT_FOR_MS;
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

/** Keeps a new pick, for whichever account opens the app next. */
export function savePlanIntent(intent: PlanIntent): void {
  keepForAnHour(KEY, { tier: intent.tier, period: intent.period });
}

/** The kept pick, checked again, since anything on this site can write the store. */
function readStored(): StoredIntent | null {
  const kept = readKept(KEY);
  if (!kept) return null;
  const stored = intentIn(kept.value);
  if (!stored) {
    clearPlanIntent();
    return null;
  }
  return { ...stored, expiresAt: kept.expiresAt };
}

function intentIn(value: unknown): (PlanIntent & { userId?: string }) | null {
  if (typeof value !== "object" || value === null) return null;
  const { tier, period, userId } = value as Record<string, unknown>;
  const plan = Object.keys(PLANS).find((name) => PLANS[name] === tier) ?? null;
  const intent = planIntentFromParams(plan, typeof period === "string" ? period : null);
  if (!intent || intent.period !== period) return null;
  if (userId !== undefined && typeof userId !== "string") return null;
  return { ...intent, ...(userId === undefined ? {} : { userId }) };
}

/** The pick still in force: under an hour old and not another account's. */
export function readPlanIntent(userId?: string): PlanIntent | null {
  const stored = readStored();
  if (!stored) return null;
  if (stored.userId !== undefined && userId !== undefined && stored.userId !== userId) return null;
  return { tier: stored.tier, period: stored.period };
}

/**
 * Gives an unclaimed pick to `userId`, telling `onClaim`, and returns it; drops a pick that is
 * stale, malformed or another account's, and returns null.
 */
export function bindPlanIntent(
  userId: string,
  onClaim?: (intent: PlanIntent) => void,
): PlanIntent | null {
  const stored = readStored();
  if (!stored || (stored.userId !== undefined && stored.userId !== userId)) {
    clearPlanIntent();
    return null;
  }
  const intent = { tier: stored.tier, period: stored.period };
  if (stored.userId === undefined) {
    // Claiming does not make the pick last longer.
    keepForAnHour(KEY, { ...intent, userId }, stored.expiresAt);
    onClaim?.(intent);
  }
  return intent;
}

export function clearPlanIntent(): void {
  forgetKept(KEY);
}
