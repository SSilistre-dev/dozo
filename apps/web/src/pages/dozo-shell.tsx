import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { BillingStatus } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
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
 * Billing is an overlay the shell keeps in its address (`?settings=billing`). The shell repairs a
 * bare `/app` to a chat as soon as its first load answers, building that address from the
 * parameters it last rendered, so an overlay written after it mounts is lost (or lands on the
 * address it just left). So the overlay is decided and written before the shell mounts: the shell
 * starts with Billing open, and its own repairs keep it.
 */
export function ShellPage() {
  const { ready, redirect } = useBillingOffer();
  if (redirect) return <Navigate to={redirect} replace />;
  return ready ? <UpstreamShellPage /> : <PageLoading />;
}

/** How long the app waits for the server before it opens without offering the pick. */
export const OFFER_CHECK_MS = 4000;

/** Billing would show the paid plans to buy: Free, owned by this member, no granted plan. */
function offersPaidPlans(status: BillingStatus): boolean {
  return (
    status.canManage &&
    status.funding === "byok" &&
    !status.byokPriceCents &&
    (status.byokTier ?? "standard") === "standard"
  );
}

/**
 * `ready` once the shell may mount; `redirect`, the same address with Billing open, until the
 * address has it.
 */
export function useBillingOffer(): { ready: boolean; redirect?: string } {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const userId = authClient.useSession().data?.user.id;
  const canceled = params.get("billing") === "canceled";
  const billingOpen = params.get("settings") === "billing";
  // "asked" once Billing is requested, "shown" once the address has it open.
  const offer = useRef<"none" | "asked" | "shown">("none");
  // A pick to check before the shell mounts, claimed for this account on the first render.
  const [checking, setChecking] = useState(() => Boolean(userId && bindPlanIntent(userId)));
  const [opening, setOpening] = useState(false);
  const settle = (answer: "offer" | "drop" | "wait") => {
    if (answer === "drop") clearPlanIntent();
    if (answer === "offer") {
      offer.current = "asked";
      setOpening(true);
    }
    setChecking(false);
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  // A slow server must not hold the app: it opens, and the pick waits for the next time.
  useTimeout(() => settleRef.current("wait"), checking ? OFFER_CHECK_MS : null);

  useEffect(() => {
    if (!checking) return;
    let active = true;
    void rpc
      .me()
      .then(async (me) =>
        me.billingEnabled && offersPaidPlans(await rpc.billing.status()) ? "offer" : "drop",
      )
      // Unknown is not Free: nothing opens, and the pick waits for the next time the app opens.
      .catch(() => "wait" as const)
      .then((answer) => {
        if (active) settleRef.current(answer);
      });
    return () => {
      active = false;
    };
  }, [checking]);

  useEffect(() => {
    if (canceled) {
      offer.current = "asked";
      return;
    }
    if (billingOpen) {
      setOpening(false);
      if (offer.current === "asked") offer.current = "shown";
      return;
    }
    if (offer.current === "shown") {
      offer.current = "none";
      clearPlanIntent();
    }
  }, [canceled, billingOpen]);

  if (checking) return { ready: false };
  if (canceled || (opening && !billingOpen)) {
    const next = new URLSearchParams(params);
    next.delete("billing");
    next.set("settings", "billing");
    return { ready: false, redirect: `${pathname}?${next}` };
  }
  return { ready: true };
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
