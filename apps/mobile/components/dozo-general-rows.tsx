import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { DozoQuietHours } from "@rakazo/contracts";
import { DOZO_DEFAULT_QUIET_HOURS } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useDozoActivity } from "../lib/dozo-activity";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-group";

const HOUR_MINUTES = Array.from({ length: 24 }, (_, hour) => hour * 60);

/**
 * General settings' rows the web app has there too: the account's quiet hours, in which its
 * routines start nothing, and the organization's activity log for those who may read it.
 */
export function DozoGeneralRows() {
  return (
    <>
      <DozoQuietHoursRows />
      <DozoActivityRow />
    </>
  );
}

/** Off shows the switch alone; on adds when quiet hours start and end. */
function DozoQuietHoursRows() {
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const locale = dateLocaleForUi(useUiLocale());
  const read = rpcQuery("dozoQuietHours/get");
  const quiet = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const save = useSave({
    save: (hours: DozoQuietHours | null, send) => send("dozoQuietHours/set", { hours }),
    stale: [read.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Couldn't update quiet hours`, errorText(error, t`Try again.`)),
  });
  const hours = save.pending ? (save.input ?? null) : (quiet.data?.hours ?? null);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const label = (minute: number) => time.format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
  const edge = (side: keyof DozoQuietHours, title: string) => {
    if (!hours) return null;
    const other = side === "startMinute" ? hours.endMinute : hours.startMinute;
    const options = HOUR_MINUTES.includes(hours[side])
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, hours[side]].sort((a, b) => a - b);
    return (
      <MenuView
        key={side}
        title={title}
        colorScheme={colorScheme}
        actions={options.map((minute) => ({
          id: String(minute),
          title: label(minute),
          state: minute === hours[side] ? ("on" as const) : ("off" as const),
          attributes: { disabled: minute === other },
        }))}
        onPressAction={({ nativeEvent }) =>
          save.run({ ...hours, [side]: Number(nativeEvent.event) })
        }
      >
        <SettingsRow
          accessible
          accessibilityRole="button"
          dimmed={save.pending}
          title={title}
          value={label(hours[side])}
        />
      </MenuView>
    );
  };
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Quiet hours`}
        value={hours !== null}
        disabled={!quiet.data || save.pending}
        onChange={(on) => save.run(on ? DOZO_DEFAULT_QUIET_HOURS : null)}
      />
      {edge("startMinute", t`Quiet hours start`)}
      {edge("endMinute", t`Quiet hours end`)}
    </SettingsGroup>
  );
}

/** Shown once the first page arrives: a refusal means this person may not read the log. */
function DozoActivityRow() {
  const { t } = useLingui();
  const router = useRouter();
  const log = useDozoActivity();
  if (!log.data) return null;
  return (
    <SettingsGroup>
      <SettingsRow
        accessibilityRole="button"
        chevron="right"
        onPress={() => router.push("/dozo-activity")}
        title={t`Activity`}
      />
    </SettingsGroup>
  );
}
