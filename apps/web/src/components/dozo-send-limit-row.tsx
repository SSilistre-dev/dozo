import { useLingui } from "@lingui/react/macro";
import { DOZO_DAILY_SEND_CHOICES } from "@rakazo/contracts";
import { Label, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";
import { SettingsRow } from "./SettingsRows";

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
          <NativeSelect
            id={selectId}
            value={value === undefined ? "" : String(value)}
            disabled={value === undefined || save.pending}
            onChange={(event) => save.run(Number(event.target.value))}
            className="w-24"
          >
            {choices.map((choice) => (
              <NativeSelectOption key={choice} value={String(choice)}>
                {String(choice)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        }
      />
    </div>
  );
}
