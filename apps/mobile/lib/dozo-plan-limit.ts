import { t } from "@lingui/core/macro";
import type { PlanLimitAction, PlanLimitBilling, PlanLimitNotice } from "@rakazo/contracts";
import { PLAN_LIMIT_CODES, planLimitNotice, planLimitOf } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Alert, Linking } from "react-native";
import { currentApiBase } from "./api";
import { queryClient, rpcQuery } from "./query";

/** The web app's Billing, served from the same origin as the API. */
export function webBillingUrl(apiBase: string): string {
  return new URL("/?settings=billing", apiBase).toString();
}

/**
 * Opens what an upgrade needs. The app's own plan choice only moves between paid plans, so a
 * first paid plan is bought on the web, in the system browser; any other change stays in the app.
 */
export function openPlanUpgrade(
  action: PlanLimitAction | null | undefined,
  openInApp: () => void,
  openUrl: (url: string) => Promise<unknown> = (url) => Linking.openURL(url),
): void {
  if (action?.kind !== "upgrade" || !action.startsPaidPlan) {
    openInApp();
    return;
  }
  // A browser that throws at once or rejects later both fall back to the app's own Billing.
  void (async () => {
    try {
      await openUrl(webBillingUrl(currentApiBase()));
    } catch {
      openInApp();
    }
  })();
}

/** Limits whose sentence and upgrade depend on the plan and on who is asking. */
function needsBilling(limit: ReturnType<typeof planLimitOf>): boolean {
  return limit === "computer_hours" || limit === PLAN_LIMIT_CODES.sharedSpaceFull;
}

/** The shared table's notice for a failure, reading the billing status only when it matters. */
export function usePlanLimitNotice(error: unknown): PlanLimitNotice | null {
  const copy = planLimitCopy();
  const limit = planLimitOf(error, copy);
  const billing = useQuery({ ...rpcQuery("billing/status"), enabled: needsBilling(limit) }).data;
  return limit ? planLimitNotice(limit, billing, copy) : null;
}

/**
 * Shows a failure that hit a limit as an alert with the table's sentence and its upgrade, and
 * says whether it did. The billing status is read first; without it the sentence offers nothing.
 */
export function showPlanLimitAlert(title: string, error: unknown): boolean {
  const copy = planLimitCopy();
  const limit = planLimitOf(error, copy);
  if (!limit || !needsBilling(limit)) return false;
  const show = (billing: PlanLimitBilling | null) => {
    const notice = planLimitNotice(limit, billing, copy);
    const action = notice?.action;
    const close = {
      text: action?.kind === "upgrade" ? t`Not Now` : t`Close`,
      style: "cancel" as const,
    };
    Alert.alert(
      title,
      notice?.text ?? (typeof error === "string" ? error : undefined),
      action?.kind === "upgrade"
        ? [
            close,
            {
              text: action.label,
              isPreferred: true,
              onPress: () => openPlanUpgrade(action, () => router.push("/billing")),
            },
          ]
        : [close],
    );
  };
  queryClient.fetchQuery(rpcQuery("billing/status")).then(show, () => show(null));
  return true;
}
