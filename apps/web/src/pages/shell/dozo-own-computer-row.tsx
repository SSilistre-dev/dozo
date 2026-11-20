import { Trans } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { ownComputerNote } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/run-error";
import { Button } from "@rakazo/ui-web";
import { useBilling } from "../../components/SubscriptionGate";
import { SwitchRow } from "./bot-settings-sections";

/**
 * The bot's Own computer switch, with one line under it while it is off: why it cannot be turned
 * on (`refusal`, the last switch the server refused, or a plan with no computer, with its upgrade),
 * else that the Team Computer is shared with the Space's other bots.
 */
export function OwnComputerRow({
  id,
  mode,
  saving,
  refusal,
  onChange,
}: {
  id: string;
  mode: ComputerMode;
  saving: boolean;
  refusal: string | null;
  onChange: (mode: ComputerMode) => void;
}) {
  const billing = useBilling();
  const note = ownComputerNote(mode, billing.status, planLimitCopy());
  const notice = note === "shared" ? null : note;
  return (
    <>
      <SwitchRow
        id={id}
        label={<Trans>Own computer</Trans>}
        checked={mode === "dedicated"}
        disabled={saving || notice !== null}
        onChange={(checked) => onChange(checked ? "dedicated" : "team")}
      />
      {refusal ? (
        <p className="pb-3 text-body-sm text-destructive">{refusal}</p>
      ) : notice ? (
        <p className="flex items-center gap-2 pb-3 text-body-sm text-muted-foreground">
          {notice.text}
          {notice.action ? (
            <Button variant="link" size="xs" className="h-auto p-0" onClick={billing.showPlans}>
              {notice.action.label}
            </Button>
          ) : null}
        </p>
      ) : note === "shared" ? (
        <p className="pb-3 text-body-sm text-muted-foreground">
          <Trans>Shared with this Space's other bots, files and sign-ins included.</Trans>
        </p>
      ) : null}
    </>
  );
}
