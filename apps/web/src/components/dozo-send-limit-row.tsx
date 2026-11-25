import { useLingui } from "@lingui/react/macro";
import { DOZO_DAILY_SEND_CHOICES } from "@rakazo/contracts";
import { Label, OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { SettingsRow } from "./settings/SettingsRows";

/**
 * How many sends each bot makes a day without asking, under the account's approval mode; past it,
 * each send asks (dozo-send-limit.ts in adapters).
 */
export function DozoSendLimitRow() {
  const { t } = useLingui();
  const selectId = useId();
  const queries = useSpaceQueries();
  const limit = useQuery({
    ...queries.dozoSendLimit.get.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const save = useSave({
    save: (dailySends: number, rpc) => rpc.dozoSendLimit.set({ dailySends }),
    stale: [queries.dozoSendLimit.get.key()],
    onFailed: (error) => toastError(t`Couldn't update daily sends`, error),
  });
  const value = save.pending ? save.input : limit.data?.dailySends;
  const choices: number[] = [...DOZO_DAILY_SEND_CHOICES];
  if (value !== undefined && !choices.includes(value)) choices.push(value);
  choices.sort((a, b) => a - b);
  return (
    <div data-testid="dozo-send-limit">
      <SettingsRow
        label={
          <Label htmlFor={selectId} className="text-body font-normal text-foreground">
            {t`Daily sends per bot`}
          </Label>
        }
        control={
          <OptionSelect
            id={selectId}
            value={value === undefined ? "" : String(value)}
            disabled={value === undefined || save.pending}
            options={choices.map((choice) => ({ value: String(choice), label: String(choice) }))}
            onValueChange={(next) => save.run(Number(next))}
            className="w-24"
          />
        }
      />
    </div>
  );
}
