import { i18n } from "@lingui/core";
import { planLimitText } from "@rakazo/contracts";

/** A billing page's failure: the shared table's sentence for a refused plan, else the fallback. */
export function billingErrorText(error: unknown, fallback: string): string {
  return planLimitText(error, i18n.locale) ?? fallback;
}
