import { useLingui } from "@lingui/react/macro";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useSpaceQueries } from "../../lib/query";

/**
 * The raw failure under a run error, for the deployment's admins only. Everyone else has the
 * summary above it, which already says what to do; the raw text is a provider's or server's own
 * words. An anchored rule puts this in place of upstream's `<details>` in composer-error.tsx.
 * Upstream renders the composer without a query client in places (its own tests); with no client
 * there is no one to recognize as an admin, so nothing is shown.
 */
export function DozoRunErrorDetails({ details }: { details: string | undefined }) {
  return useContext(QueryClientContext) ? <AdminDetails details={details} /> : null;
}

function AdminDetails({ details }: { details: string | undefined }) {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (!me.data?.isAdmin) return null;
  return (
    <details className="mt-1">
      <summary className="w-fit cursor-pointer">{t`Details`}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-label">{details}</pre>
    </details>
  );
}
