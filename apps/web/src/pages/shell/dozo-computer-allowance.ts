import { isComputerAllowanceUsed, planLimitNotice } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";
import { useBilling } from "../../components/SubscriptionGate";

/**
 * What the computer screen shows for a failure: a start refused for hours reads its sentence and
 * upgrade from the plan table (Free is told its plan has no computer), never the server's words.
 * `upgrade` is the button's label, or null for no button.
 */
export function useComputerAllowance(
  failure: string | null,
  running: boolean,
): { allowanceUsed: boolean; text: string | null; upgrade: string | null } {
  const billing = useBilling().status;
  const allowanceUsed = !running && isComputerAllowanceUsed(failure);
  if (!allowanceUsed) return { allowanceUsed, text: failure, upgrade: null };
  const copy = planLimitCopy();
  const notice = planLimitNotice("computer_hours", billing, copy);
  // A trial or a credit plan has no table sentence: it keeps upstream's Upgrade.
  if (!notice) return { allowanceUsed, text: copy.noComputerHours, upgrade: copy.upgrade };
  return { allowanceUsed, text: notice.text, upgrade: notice.action?.label ?? null };
}
