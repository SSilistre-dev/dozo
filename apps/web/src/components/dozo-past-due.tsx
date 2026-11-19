import { Trans, useLingui } from "@lingui/react/macro";
import { paymentPastDue } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { toastError } from "../lib/dozo-error-text";
import { rpc } from "../lib/rpc";
import { useBilling } from "./SubscriptionGate";

/**
 * One line while the subscription is past due, for the member who manages billing, with the way
 * to fix it. The gate reads billing again when the window comes back, so it goes once paid.
 */
export function DozoPastDue() {
  const { t } = useLingui();
  const { status } = useBilling();
  const [opening, setOpening] = useState(false);
  if (!paymentPastDue(status)) return null;
  const manage = async () => {
    setOpening(true);
    try {
      const { url } = await rpc.billing.portal();
      window.location.assign(url);
    } catch (error) {
      toastError(t`Could not open billing`, error);
    } finally {
      // Desktop opens the URL in the system browser and this page stays.
      setOpening(false);
    }
  };
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-3 border-t bg-muted px-4 py-1.5 text-body-sm"
    >
      <span className="truncate text-warning">
        <Trans>Your last payment didn't go through.</Trans>
      </span>
      <Button size="xs" variant="outline" disabled={opening} onClick={() => void manage()}>
        <Trans>Manage billing</Trans>
      </Button>
    </div>
  );
}
