import { planLimitText } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";

/** A billing page's failure: the shared table's sentence for a refused plan, else the fallback. */
export function billingErrorText(error: unknown, fallback: string): string {
  return planLimitText(error, planLimitCopy()) ?? fallback;
}
