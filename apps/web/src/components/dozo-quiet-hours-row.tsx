import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoQuietRange } from "@rakazo/contracts";
import { DOZO_MAX_QUIET_RANGES, DOZO_QUIET_DAYS } from "@rakazo/contracts";
import type { DozoQuietDayPreset } from "@rakazo/core";
import {
  DOZO_DEFAULT_QUIET_RANGE,
  DOZO_QUIET_DAY_PRESETS,
  DOZO_WEEKDAYS,
  dozoQuietDayList,
  dozoQuietDayPreset,
  dozoQuietHasDay,
  dozoQuietToggleDay,
  dozoWeekdayName,
} from "@rakazo/core";
import {
  Button,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  toast,
} from "@rakazo/ui-web";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";
import { SettingsRow } from "./SettingsRows";

const HOUR_MINUTES = Array.from({ length: 24 }, (_, hour) => hour * 60);
/** The days choice that opens the single days. */
const CUSTOM = "custom";

/**
 * The account's quiet hours, under its timezone in General settings: routines due inside them
 * wait until they end. Off shows the switch alone; on adds each range's start, end and days.
 * Suggest asks the server once, shows what it would set, and saves only when it is used.
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
    save: (ranges: DozoQuietRange[], rpc) => rpc.dozoQuietHours.set({ ranges }),
    stale: [queries.dozoQuietHours.get.key()],
    onFailed: (error) => toastError(t`Couldn't update quiet hours`, error),
  });
  const suggest = useMutation({
    mutationFn: () => queries.dozoQuietHours.suggest.call(),
    onSuccess: ({ ranges: suggested }) => {
      if (!suggested) toast(t`Not enough activity yet.`);
    },
    onError: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
  // The range whose single days were asked for while its days still have a name.
  const [openDays, setOpenDays] = useState<number | null>(null);
  const ranges = save.pending ? (save.input ?? []) : (quiet.data?.ranges ?? []);
  const suggested = suggest.data?.ranges ?? null;
  const time = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const label = (minute: number) => time.format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
  const presetLabel: Record<DozoQuietDayPreset, string> = {
    ALL: t`Every day`,
    WEEKDAYS: t`Weekdays`,
    WEEKEND: t`Weekends`,
  };
  const daysLabel = (days: number) => {
    const preset = dozoQuietDayPreset(days);
    return preset ? presetLabel[preset] : dozoQuietDayList(days, i18n.locale);
  };
  const span = (range: DozoQuietRange) => `${label(range.startMinute)} – ${label(range.endMinute)}`;
  const change = (index: number, range: DozoQuietRange) =>
    save.run(ranges.map((entry, at) => (at === index ? range : entry)));

  const edge = (
    range: DozoQuietRange,
    index: number,
    side: "startMinute" | "endMinute",
    name: string,
  ) => {
    const other = side === "startMinute" ? range.endMinute : range.startMinute;
    const options = HOUR_MINUTES.includes(range[side])
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, range[side]].sort((a, b) => a - b);
    return (
      <NativeSelect
        aria-label={name}
        value={String(range[side])}
        disabled={save.pending}
        onChange={(event) => change(index, { ...range, [side]: Number(event.target.value) })}
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

  const rangeRow = (range: DozoQuietRange, index: number) => {
    const preset = dozoQuietDayPreset(range.days);
    const single = !preset || openDays === index;
    return (
      <fieldset
        // Ranges have no id of their own; a row is its place in the list.
        key={index}
        aria-label={span(range)}
        className="group/range mt-2 flex min-w-0 flex-col items-end gap-2"
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          {edge(range, index, "startMinute", t`Quiet hours start`)}
          <span aria-hidden="true" className="text-muted-foreground">
            –
          </span>
          {edge(range, index, "endMinute", t`Quiet hours end`)}
          <NativeSelect
            aria-label={t`Days`}
            value={single ? CUSTOM : preset}
            disabled={save.pending}
            onChange={(event) => {
              const next = event.target.value;
              if (next === CUSTOM) return setOpenDays(index);
              setOpenDays(null);
              change(index, { ...range, days: DOZO_QUIET_DAYS[next as DozoQuietDayPreset] });
            }}
            className="w-32"
          >
            {DOZO_QUIET_DAY_PRESETS.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {presetLabel[option]}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value={CUSTOM}>{t`Custom`}</NativeSelectOption>
          </NativeSelect>
          {ranges.length > 1 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              // A rare action: shown on the range a pointer is over or focus is in.
              className="pointer-fine:opacity-0 pointer-fine:group-focus-within/range:opacity-100 pointer-fine:group-hover/range:opacity-100"
              disabled={save.pending}
              onClick={() => {
                setOpenDays(null);
                save.run(ranges.filter((_, at) => at !== index));
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
        {single ? (
          <ToggleGroup
            multiple
            size="sm"
            aria-label={t`Days`}
            value={DOZO_WEEKDAYS.filter((day) => dozoQuietHasDay(range.days, day)).map(String)}
            onValueChange={(next) => {
              const days = next.reduce((mask, day) => mask | (1 << Number(day)), 0);
              if (days !== 0) change(index, { ...range, days });
            }}
          >
            {DOZO_WEEKDAYS.map((day) => (
              <ToggleGroupItem
                key={day}
                value={String(day)}
                aria-label={dozoWeekdayName(day, i18n.locale, "long")}
                // The only day left stays: a range is on at least one day.
                disabled={save.pending || dozoQuietToggleDay(range.days, day) === range.days}
                className="size-7 min-w-7 px-0"
              >
                {dozoWeekdayName(day, i18n.locale, "narrow")}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </fieldset>
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
          <>
            {suggested ? null : (
              <Button
                variant="text"
                size="sm"
                disabled={quiet.isPending || quiet.isError || suggest.isPending}
                onClick={() => suggest.mutate()}
              >
                {t`Suggest`}
              </Button>
            )}
            <Switch
              id={switchId}
              checked={ranges.length > 0}
              disabled={quiet.isPending || quiet.isError || save.pending}
              onCheckedChange={(on) => {
                setOpenDays(null);
                save.run(on ? [DOZO_DEFAULT_QUIET_RANGE] : []);
              }}
            />
          </>
        }
      >
        {ranges.map(rangeRow)}
        {ranges.length > 0 && ranges.length < DOZO_MAX_QUIET_RANGES ? (
          <div className="mt-2 flex justify-end">
            <Button
              variant="text"
              size="sm"
              disabled={save.pending}
              onClick={() => save.run([...ranges, DOZO_DEFAULT_QUIET_RANGE])}
            >
              <Plus data-icon="inline-start" />
              {t`Add range`}
            </Button>
          </div>
        ) : null}
        {suggested ? (
          <div
            data-testid="dozo-quiet-hours-suggestion"
            className="mt-3 flex flex-wrap items-end justify-between gap-3 rounded-lg bg-muted px-3 py-2"
          >
            <ul className="text-body-sm text-muted-foreground">
              {suggested.map((range, index) => (
                <li key={index} className="flex gap-3">
                  <span className="text-foreground">{span(range)}</span>
                  <span>{daysLabel(range.days)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <Button variant="text" size="sm" onClick={() => suggest.reset()}>
                {t`Cancel`}
              </Button>
              <Button
                size="sm"
                disabled={save.pending}
                onClick={() => {
                  setOpenDays(null);
                  save.run(suggested);
                  suggest.reset();
                }}
              >
                {t`Use`}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
    </div>
  );
}
