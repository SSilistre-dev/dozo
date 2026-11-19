import type { BillingStatus } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import {
  bindPlanIntent,
  clearPlanIntent,
  planIntentFromParams,
  savePlanIntent,
} from "../lib/dozo-plan-intent";
import { rpc } from "../lib/rpc";
import { ShellPage as UpstreamShellPage } from "./Shell";

/**
 * Upstream's app shell, which also opens Billing when there is a plan to offer:
 *
 * - A paid plan picked on the landing page (`dozo-plan-intent`) is offered once the app opens after
 *   sign-up and setup, preselected in Billing. Closing Billing is the answer: the pick is forgotten
 *   and the account goes on with Free. It is offered only to an account on Free that manages its
 *   billing, on a server that bills; anywhere else the pick is dropped without a word.
 * - A checkout left without paying returns with `?billing=canceled`; Billing opens again, as it was,
 *   with no error, and the parameter leaves the address.
 *
 * The shell keeps its overlay in the address (`?settings=billing`) and its own route repairs keep
 * it, so this only writes that.
 */
export function ShellPage() {
  useBillingOffer();
  return <UpstreamShellPage />;
}

/** Billing would show the paid plans to buy: Free, owned by this member, no granted plan. */
function offersPaidPlans(status: BillingStatus): boolean {
  return (
    status.canManage &&
    status.funding === "byok" &&
    !status.byokPriceCents &&
    (status.byokTier ?? "standard") === "standard"
  );
}

export function useBillingOffer() {
  const [params, setParams] = useSearchParams();
  const userId = authClient.useSession().data?.user.id;
  const canceled = params.get("billing") === "canceled";
  const billingOpen = params.get("settings") === "billing";
  // "checking" while the server is asked, "asked" once Billing is requested, "shown" once the
  // address has it open.
  const offer = useRef<"none" | "checking" | "asked" | "shown">("none");
  const openBilling = useRef(() => {});
  openBilling.current = () => {
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
  };

  useEffect(() => {
    if (!userId || offer.current !== "none" || !bindPlanIntent(userId)) return;
    offer.current = "checking";
    let active = true;
    void rpc
      .me()
      .then(async (me) =>
        me.billingEnabled && offersPaidPlans(await rpc.billing.status()) ? "offer" : "drop",
      )
      // Unknown is not Free: nothing opens, and the pick waits for the next time the app opens.
      .catch(() => "wait" as const)
      .then((answer) => {
        if (!active) return;
        if (answer === "drop") clearPlanIntent();
        // A checkout left unpaid may have opened Billing meanwhile; that offer stands as it is.
        if (offer.current !== "checking") return;
        if (answer === "offer") return openBilling.current();
        offer.current = "none";
      });
    return () => {
      active = false;
      if (offer.current === "checking") offer.current = "none";
    };
  }, [userId]);

  useEffect(() => {
    if (canceled) return openBilling.current();
    if (billingOpen) {
      if (offer.current === "asked") offer.current = "shown";
      return;
    }
    if (offer.current === "shown") {
      offer.current = "none";
      clearPlanIntent();
    }
  }, [canceled, billingOpen]);
}

/**
 * Where a signed-in account lands from the sign-in or sign-up address: a plan the link names is
 * kept first, so a member already signed in who picks a plan on the landing page is offered it.
 */
export function NavigateKeepingPlan({ to }: { to: string }) {
  const [params] = useSearchParams();
  const intent = planIntentFromParams(params.get("plan"), params.get("period"));
  const tier = intent?.tier;
  const period = intent?.period;
  // Before the redirect lands: this runs in the same commit as the redirect's own effect.
  useEffect(() => {
    if (tier && period) savePlanIntent({ tier, period });
  }, [tier, period]);
  return <Navigate to={to} replace />;
}
