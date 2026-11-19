import type { ByokInterval, ByokTier } from "@rakazo/contracts";

/**
 * A paid plan picked on the landing page before the visitor has an account. Its links to sign-up
 * carry `?plan=premium|premium_plus&period=month|year`; the sign-up page keeps the pick in session
 * storage for this tab, and once the app opens Billing offers it, preselected. Free, or anything
 * that is not one of these values, is no pick. Prices are never read from here: the server prices
 * the tier and period it is sent.
 */
export type PlanIntent = { tier: ByokTier; period: ByokInterval };

const KEY = "dozo:plan-intent";
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

export function savePlanIntent(intent: PlanIntent): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(intent));
  } catch {
    // A full or refused store keeps no pick; sign-up goes on as without one.
  }
}

/** The kept pick, checked again, since anything in this tab can write the store. */
export function readPlanIntent(): PlanIntent | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { tier, period } = value as Record<string, unknown>;
    const plan = Object.keys(PLANS).find((name) => PLANS[name] === tier) ?? null;
    const intent = planIntentFromParams(plan, typeof period === "string" ? period : null);
    return intent && intent.period === period ? intent : null;
  } catch {
    return null;
  }
}

export function clearPlanIntent(): void {
  storage()?.removeItem(KEY);
}
