import { useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { planEndDays, planEndWarns } from "@rakazo/contracts";
import { formatBillingDate } from "../lib/billing";

/**
 * When the plan in force renews or ends, and the days left; nothing when it has no end. A granted
 * plan above a subscription says which plan follows instead, and the subscription keeps its date.
 */
export function DozoPlanEnd({ status }: { status: BillingStatus }) {
  const { t, i18n } = useLingui();
  const end = status.planEnd;
  if (!end) return null;
  const day = formatBillingDate(end.at, i18n.locale || "en");
  const count = planEndDays(end);
  const remaining = t`${count} days`;
  const left = end.fallsTo
    ? `${end.fallsTo.from} → ${end.fallsTo.to}`
    : count <= 0
      ? t`Today`
      : count === 1
        ? t`Tomorrow`
        : t`${remaining} left`;
  return (
    <p
      data-testid="plan-end"
      className={`mt-2 text-body ${planEndWarns(end) ? "text-warning" : "text-muted-foreground"}`}
    >
      {end.renews ? t`Renews ${day}` : t`Ends ${day}`} · {left}
    </p>
  );
}
