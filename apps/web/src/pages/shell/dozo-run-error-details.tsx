import { useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { PLAN_LIMIT_CODES, planHasNoComputer, planLimitOf } from "@rakazo/contracts";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useBilling } from "../../components/SubscriptionGate";
import { useSpaceQueries } from "../../lib/query";

/**
 * The raw failure under a run error, for the deployment's admins only. Everyone else has the
 * summary above it, which already says what to do; the raw text is a provider's or server's own
 * words. An anchored rule puts this in place of upstream's `<details>` in composer-error.tsx.
 * Upstream renders the composer without a query client in places (its own tests); with no client
 * there is no one to recognize as an admin, so nothing is shown.
 * A plan limit shows its code instead (computer_not_in_plan, shared_space_full, ...): the summary
 * already says it in the UI's language, and the server's English sentence would only repeat it.
 */
export function DozoRunErrorDetails({ details }: { details: string | undefined }) {
  return useContext(QueryClientContext) ? <AdminDetails details={details} /> : null;
}

function AdminDetails({ details }: { details: string | undefined }) {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const billing = useBilling().status;
  if (!me.data?.isAdmin) return null;
  return (
    <details className="mt-1">
      <summary className="w-fit cursor-pointer">{t`Details`}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-label">
        {planLimitCode(details, billing) ?? details}
      </pre>
    </details>
  );
}

/** The code of a plan limit's failure; null for any other failure. */
export function planLimitCode(
  details: string | undefined,
  billing: BillingStatus | null,
): string | null {
  const limit = details ? planLimitOf(details) : null;
  if (limit !== "computer_hours") return limit;
  return planHasNoComputer(billing)
    ? PLAN_LIMIT_CODES.computerNotInPlan
    : PLAN_LIMIT_CODES.computerHoursUsed;
}
