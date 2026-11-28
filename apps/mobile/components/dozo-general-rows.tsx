import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { DozoQuietRange } from "@rakazo/contracts";
import {
  DOZO_DEFAULT_DIGEST_MINUTE,
  DOZO_MAX_QUIET_RANGES,
  DOZO_QUIET_DAYS,
} from "@rakazo/contracts";
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
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useDozoActivity } from "../lib/dozo-activity";
import { useFeedbackStatus } from "../lib/dozo-feedback";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n/i18n";
import { useResolvedAppearance } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { errorText } from "../lib/api/user-error";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings/settings-group";

const HOUR_MINUTES = Array.from({ length: 24 }, (_, hour) => hour * 60);

/**
 * General settings' rows the web app has there too: the account's quiet hours, in which its
 * routines start nothing, its daily digest, the organization's activity log for those who may
 * read it, and the access tokens and feedback the web app keeps under Security and its account
 * menu.
 */
export function DozoGeneralRows() {
  return (
    <>
      <DozoQuietHoursRows />
      <DozoDailyDigestRows />
      <DozoActivityRow />
      <DozoTokensAndFeedbackRows />
    </>
  );
}

type Digest = { botId: string; minute: number } | null;

/**
 * Off shows the switch alone, and nothing while this Space has no bot to write it; on adds the
 * time, and the bot when there is more than one to pick.
 */
function DozoDailyDigestRows() {
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const locale = dateLocaleForUi(useUiLocale());
  const read = rpcQuery("dozoDailyDigest/get");
  const current = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const bots = useQuery(rpcQuery("bots/list"), queryClient);
  const save = useSave({
    save: (digest: Digest, send) => send("dozoDailyDigest/set", { digest }),
    stale: [read.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Couldn't update the daily digest`, errorText(error, t`Try again.`)),
  });
  const saved = current.data?.digest ?? null;
  const digest = save.pending
    ? save.input
      ? { ...save.input, botName: saved?.botName ?? "" }
      : null
    : saved;
  const firstBot = bots.data?.[0];
  if (!digest && !firstBot) return null;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const label = (minute: number) => time.format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
  const minutes =
    digest?.minute == null || HOUR_MINUTES.includes(digest.minute)
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, digest.minute].sort((a, b) => a - b);
  const botOptions = (bots.data ?? []).map((bot) => ({ id: bot.id, name: bot.name }));
  if (digest && !botOptions.some((bot) => bot.id === digest.botId))
    botOptions.unshift({ id: digest.botId, name: digest.botName });
  const minute = digest?.minute ?? DOZO_DEFAULT_DIGEST_MINUTE;
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Daily digest`}
        value={digest !== null}
        disabled={!current.data || save.pending}
        onChange={(on) =>
          save.run(
            on && firstBot ? { botId: firstBot.id, minute: DOZO_DEFAULT_DIGEST_MINUTE } : null,
          )
        }
      />
      {digest ? (
        <MenuView
          title={t`Time`}
          colorScheme={colorScheme}
          actions={minutes.map((option) => ({
            id: String(option),
            title: label(option),
            state: option === digest.minute ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) =>
            save.run({ botId: digest.botId, minute: Number(nativeEvent.event) })
          }
        >
          <SettingsRow
            accessible
            accessibilityRole="button"
            dimmed={save.pending}
            title={t`Time`}
            value={digest.minute == null ? "" : label(digest.minute)}
          />
        </MenuView>
      ) : null}
      {digest && botOptions.length > 1 ? (
        <MenuView
          title={t`Bot`}
          colorScheme={colorScheme}
          actions={botOptions.map((bot) => ({
            id: bot.id,
            title: bot.name,
            state: bot.id === digest.botId ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => save.run({ botId: nativeEvent.event, minute })}
        >
          <SettingsRow
            accessible
            accessibilityRole="button"
            dimmed={save.pending}
            title={t`Bot`}
            value={botOptions.find((bot) => bot.id === digest.botId)?.name ?? ""}
          />
        </MenuView>
      ) : null}
    </SettingsGroup>
  );
}

/**
 * Off shows the switch alone; on adds one row per range, its start, end and days in its menu, and
 * Add range while there is room. Suggest asks the server once and saves only what is used.
 */
function DozoQuietHoursRows() {
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const locale = dateLocaleForUi(useUiLocale());
  const read = rpcQuery("dozoQuietHours/get");
  const quiet = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const save = useSave({
    save: (ranges: DozoQuietRange[], send) => send("dozoQuietHours/set", { ranges }),
    stale: [read.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Couldn't update quiet hours`, errorText(error, t`Try again.`)),
  });
  const ranges = save.pending ? (save.input ?? []) : (quiet.data?.ranges ?? []);
  const time = new Intl.DateTimeFormat(locale, {
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
    return preset ? presetLabel[preset] : dozoQuietDayList(days, locale);
  };
  const span = (range: DozoQuietRange) => `${label(range.startMinute)} – ${label(range.endMinute)}`;
  const suggest = useSave({
    save: (_, send) => send("dozoQuietHours/suggest", undefined),
    onSaved: ({ ranges: suggested }) => {
      if (!suggested) return Alert.alert(t`Not enough activity yet.`);
      Alert.alert(
        t`Quiet hours`,
        suggested.map((range) => `${span(range)}, ${daysLabel(range.days)}`).join("\n"),
        [
          { text: t`Cancel`, style: "cancel" },
          { text: t`Use`, onPress: () => save.run(suggested) },
        ],
      );
    },
    onFailed: (error) => Alert.alert(t`Quiet hours`, errorText(error, t`Try again.`)),
  });

  const edgeActions = (range: DozoQuietRange, edge: "startMinute" | "endMinute") => {
    const other = edge === "startMinute" ? range.endMinute : range.startMinute;
    const options = HOUR_MINUTES.includes(range[edge])
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, range[edge]].sort((a, b) => a - b);
    return options.map((minute) => ({
      id: `${edge === "startMinute" ? "start" : "end"}:${minute}`,
      title: label(minute),
      state: minute === range[edge] ? ("on" as const) : ("off" as const),
      attributes: { disabled: minute === other },
    }));
  };
  const rangeRow = (range: DozoQuietRange, index: number) => {
    const change = (next: DozoQuietRange) =>
      save.run(ranges.map((entry, at) => (at === index ? next : entry)));
    const onPressAction = ({ nativeEvent }: { nativeEvent: { event: string } }) => {
      const [kind, value] = nativeEvent.event.split(":");
      if (kind === "start") change({ ...range, startMinute: Number(value) });
      else if (kind === "end") change({ ...range, endMinute: Number(value) });
      else if (kind === "days")
        change({ ...range, days: DOZO_QUIET_DAYS[value as DozoQuietDayPreset] });
      else if (kind === "day") {
        const days = dozoQuietToggleDay(range.days, Number(value));
        if (days !== range.days) change({ ...range, days });
      } else if (kind === "remove") save.run(ranges.filter((_, at) => at !== index));
    };
    const title = span(range);
    return (
      <MenuView
        // Ranges have no id of their own; a row is its place in the list.
        key={index}
        title={title}
        colorScheme={colorScheme}
        actions={[
          {
            id: "start",
            title: t`Quiet hours start`,
            subactions: edgeActions(range, "startMinute"),
          },
          { id: "end", title: t`Quiet hours end`, subactions: edgeActions(range, "endMinute") },
          {
            id: "days",
            title: t`Days`,
            subactions: [
              {
                id: "named",
                title: "",
                displayInline: true,
                subactions: DOZO_QUIET_DAY_PRESETS.map((preset) => ({
                  id: `days:${preset}`,
                  title: presetLabel[preset],
                  state:
                    DOZO_QUIET_DAYS[preset] === range.days ? ("on" as const) : ("off" as const),
                })),
              },
              {
                id: "each",
                title: "",
                displayInline: true,
                subactions: DOZO_WEEKDAYS.map((day) => ({
                  id: `day:${day}`,
                  title: dozoWeekdayName(day, locale, "long"),
                  state: dozoQuietHasDay(range.days, day) ? ("on" as const) : ("off" as const),
                  // The only day left stays: a range is on at least one day.
                  attributes: { disabled: dozoQuietToggleDay(range.days, day) === range.days },
                })),
              },
            ],
          },
          ...(ranges.length > 1
            ? [{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]
            : []),
        ]}
        onPressAction={onPressAction}
      >
        <SettingsRow
          accessible
          accessibilityRole="button"
          dimmed={save.pending}
          title={title}
          value={daysLabel(range.days)}
        />
      </MenuView>
    );
  };
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Quiet hours`}
        value={ranges.length > 0}
        disabled={!quiet.data || save.pending}
        onChange={(on) => save.run(on ? [DOZO_DEFAULT_QUIET_RANGE] : [])}
      />
      {ranges.map(rangeRow)}
      {ranges.length > 0 && ranges.length < DOZO_MAX_QUIET_RANGES ? (
        <SettingsRow
          accessibilityRole="button"
          dimmed={save.pending}
          onPress={() => save.run([...ranges, DOZO_DEFAULT_QUIET_RANGE])}
          title={t`Add range`}
        />
      ) : null}
      {quiet.data ? (
        <SettingsRow
          accessibilityRole="button"
          dimmed={suggest.pending}
          onPress={() => suggest.run()}
          title={t`Suggest`}
        />
      ) : null}
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

/** Access tokens always; Send feedback only where the server takes it, as on the web. */
function DozoTokensAndFeedbackRows() {
  const { t } = useLingui();
  const router = useRouter();
  const feedback = useFeedbackStatus();
  return (
    <SettingsGroup>
      <SettingsRow
        accessibilityRole="button"
        chevron="right"
        onPress={() => router.push("/dozo-access-tokens")}
        title={t`Access tokens`}
      />
      {feedback?.mode ? (
        <SettingsRow
          accessibilityRole="button"
          chevron="right"
          onPress={() => router.push("/dozo-feedback")}
          title={t`Send feedback`}
        />
      ) : null}
    </SettingsGroup>
  );
}
