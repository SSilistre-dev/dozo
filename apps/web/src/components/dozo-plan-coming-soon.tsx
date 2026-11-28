import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";

/**
 * Where Free would subscribe, a paid plan that is not on sale yet: its name and monthly price on a
 * button that cannot be pressed. The server refuses its checkout too.
 */
export function DozoPlanComingSoon({ plan, price }: { plan: string; price: string }) {
  return (
    <Button disabled>
      <Trans>
        {plan} · {price} / month · Coming soon
      </Trans>
    </Button>
  );
}
