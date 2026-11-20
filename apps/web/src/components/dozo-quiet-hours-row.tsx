import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoQuietHours } from "@rakazo/contracts";
import { Label, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";
import { SettingsRow } from "./SettingsRows";

/** What turning quiet hours on starts with: the night. */
export const DOZO_DEFAULT_QUIET_HOURS: DozoQuietHours = { startMinute: 22 * 60, endMinute: 7 * 60 };

const HOUR_MINUTES = Array.from({ length: 24 }, (_, hour) => hour * 60);

/**
 * The account's quiet hours, under its timezone in General settings: routines due inside them
 * wait until they end. Off shows the switch alone; on adds the start and the end.
 */
export function DozoQuietHoursRow() {
  const { t, i18n } = useLingui();
  const switchId = useId();
  const queries = useSpaceQueries();
  const quiet = useQuery({
    ...queries.dozoQuietHours.get.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const save = useSave({
    save: (hours: DozoQuietHours | null, rpc) => rpc.dozoQuietHours.set({ hours }),
    stale: [queries.dozoQuietHours.get.key()],
    onFailed: (error) => toastError(t`Couldn't update quiet hours`, error),
  });
  const hours = save.pending ? (save.input ?? null) : (quiet.data?.hours ?? null);
  const time = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const label = (minute: number) => time.format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
  const select = (edge: keyof DozoQuietHours, name: string) => {
    if (!hours) return null;
    const other = edge === "startMinute" ? hours.endMinute : hours.startMinute;
    const options = HOUR_MINUTES.includes(hours[edge])
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, hours[edge]].sort((a, b) => a - b);
    return (
      <NativeSelect
        aria-label={name}
        value={String(hours[edge])}
        disabled={save.pending}
        onChange={(event) => save.run({ ...hours, [edge]: Number(event.target.value) })}
        className="w-28"
      >
        {options.map((minute) => (
          <NativeSelectOption key={minute} value={String(minute)} disabled={minute === other}>
            {label(minute)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  };
  return (
    <div data-testid="dozo-quiet-hours">
      <SettingsRow
        label={
          <Label htmlFor={switchId} className="text-body font-normal text-foreground">
            <Trans>Quiet hours</Trans>
          </Label>
        }
        control={
          <Switch
            id={switchId}
            checked={hours !== null}
            disabled={quiet.isPending || quiet.isError || save.pending}
            onCheckedChange={(on) => save.run(on ? DOZO_DEFAULT_QUIET_HOURS : null)}
          />
        }
      >
        {hours ? (
          <div className="mt-2 flex items-center justify-end gap-2">
            {select("startMinute", t`Quiet hours start`)}
            <span aria-hidden="true" className="text-muted-foreground">
              –
            </span>
            {select("endMinute", t`Quiet hours end`)}
          </div>
        ) : null}
      </SettingsRow>
    </div>
  );
}
