import { Trans } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { ownComputerNote } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/run-error";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useBilling } from "../../components/SubscriptionGate";
import { SwitchRow } from "./bot-settings-sections";

/**
 * The bot's Own computer switch, with one line under it while it is off: why it cannot be turned
 * on (`refusal`, the last switch the server refused, or a plan with no computer, with its upgrade),
 * else that the Team Computer is shared with the Space's other bots. A switch asks first, since the
 * bot's files and browser sign-ins move with it.
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
  const [moving, setMoving] = useState<ComputerMode | null>(null);
  return (
    <>
      <SwitchRow
        id={id}
        label={<Trans>Own computer</Trans>}
        checked={mode === "dedicated"}
        disabled={saving || notice !== null}
        onChange={(checked) => setMoving(checked ? "dedicated" : "team")}
      />
      {moving ? (
        <ConfirmDialog
          variant="default"
          title={
            moving === "dedicated" ? (
              <Trans>
                This bot's files and browser sign-ins move to its own computer and are removed from
                the Team Computer.
              </Trans>
            ) : (
              <Trans>
                This bot's files and browser sign-ins move to the Team Computer, where this Space's
                other bots can open them.
              </Trans>
            )
          }
          confirmLabel={<Trans>Move</Trans>}
          onCancel={() => setMoving(null)}
          onConfirm={() => {
            setMoving(null);
            onChange(moving);
          }}
        />
      ) : null}
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
