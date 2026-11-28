import { Trans, useLingui } from "@lingui/react/macro";
import { formatBillingPrice } from "@rakazo/i18n/billing";
import { Button } from "@rakazo/ui-web";

/**
 * Where Free would subscribe, a paid plan that is not on sale yet: its name and monthly price,
 * muted, beside a button that cannot be pressed. The server refuses its checkout too.
 */
export function DozoPlanComingSoon({ plan, monthlyCents }: { plan: string; monthlyCents: number }) {
  const { i18n } = useLingui();
  const price = formatBillingPrice(
    { amount: monthlyCents, currency: "usd", interval: "month", intervalCount: 1 },
    i18n.locale,
  );
  return (
    <>
      <span className="text-body text-muted-foreground">{plan}</span>
      <span className="text-body tabular-nums text-muted-foreground">{price}</span>
      <Button disabled>
        <Trans>Coming soon</Trans>
      </Button>
    </>
  );
}
