import { DOZO_PLAN_LIMIT_KINDS, planLimitOf, planLimitText } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";
import { sendEvent } from "./dozo-event-sender";

/** A billing page's failure: the shared table's sentence for a refused plan, else the fallback. */
export function billingErrorText(error: unknown, fallback: string): string {
  return planLimitText(error, planLimitCopy()) ?? fallback;
}

/** Reports a refusal that is a limit the member can upgrade out of, then rejects with it. */
export function notePlanLimit(client: Parameters<typeof sendEvent>[0], error: unknown): never {
  const kind = DOZO_PLAN_LIMIT_KINDS.find((value) => value === planLimitOf(error));
  // Measurement only: the caller still gets the refusal.
  if (kind) sendEvent(client, { name: "plan_limit_hit", kind });
  throw error;
}
