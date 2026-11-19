import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { clearPlanIntent, readPlanIntent } from "../lib/dozo-plan-intent";
import { ShellPage as UpstreamShellPage } from "./Shell";

/**
 * Upstream's app shell, which also opens Billing when there is a plan to offer:
 *
 * - A paid plan picked on the landing page (`dozo-plan-intent`) is offered once the app opens after
 *   sign-up and setup, preselected in Billing. Closing Billing is the answer: the pick is forgotten
 *   and the account goes on with Free. Nothing opens without a pick.
 * - A checkout left without paying returns with `?billing=canceled`; Billing opens again, as it was,
 *   with no error, and the parameter leaves the address.
 *
 * The shell keeps its overlay in the address (`?settings=billing`), so this only writes that.
 */
export function ShellPage() {
  useBillingOffer();
  return <UpstreamShellPage />;
}

export function useBillingOffer() {
  const [params, setParams] = useSearchParams();
  const canceled = params.get("billing") === "canceled";
  const billingOpen = params.get("settings") === "billing";
  // "asked" once Billing is requested, "shown" once the address has it open.
  const offer = useRef<"none" | "asked" | "shown">("none");
  useEffect(() => {
    if (canceled || (offer.current === "none" && readPlanIntent())) {
      offer.current = "asked";
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("billing");
          next.set("settings", "billing");
          return next;
        },
        { replace: true },
      );
      return;
    }
    if (billingOpen) {
      if (offer.current === "asked") offer.current = "shown";
      return;
    }
    if (offer.current === "shown") {
      offer.current = "none";
      clearPlanIntent();
    }
  }, [canceled, billingOpen, setParams]);
}
