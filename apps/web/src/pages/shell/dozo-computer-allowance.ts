import { isComputerAllowanceUsed, planHasNoComputer, planLimitNotice } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/run-error";
import { useBilling } from "../../components/billing/SubscriptionGate";

/**
 * What the computer screen shows for a failure: a start refused for hours reads its sentence and
 * upgrade from the plan table (Free is told its plan has no computer), never the server's words.
 * `upgrade` is the button's label, or null for no button. `ownDevice` is true when the plan has no
 * computer at all: that member's other way is a computer of their own.
 */
export function useComputerAllowance(
  failure: string | null,
  running: boolean,
): { allowanceUsed: boolean; text: string | null; upgrade: string | null; ownDevice: boolean } {
  const billing = useBilling().status;
  const allowanceUsed = !running && isComputerAllowanceUsed(failure);
  if (!allowanceUsed) return { allowanceUsed, text: failure, upgrade: null, ownDevice: false };
  const copy = planLimitCopy();
  const notice = planLimitNotice("computer_hours", billing, copy);
  // A trial or a credit plan has no table sentence: it keeps upstream's Upgrade.
  if (!notice) return { allowanceUsed, text: copy.noComputerHours, upgrade: copy.upgrade, ownDevice: false };
  return {
    allowanceUsed,
    text: notice.text,
    upgrade: notice.action?.label ?? null,
    ownDevice: planHasNoComputer(billing),
  };
}
