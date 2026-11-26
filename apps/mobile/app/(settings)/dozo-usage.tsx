import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { DozoUsageGroup, DozoUsageGrouping } from "@rakazo/contracts";
import { dozoLocalDay } from "@rakazo/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSegmentedControl } from "../../components/native/native-segmented-control";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { mobileTokens } from "../../lib/appearance/appearance";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n/i18n";
import { native, useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery } from "../../lib/query/query";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { useSideInsets } from "../../lib/layout/side-insets";
import { errorText } from "../../lib/api/user-error";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The caller's spend in this Space grouped by model, bot, routine or day (and, for an owner, person), as the web app's Usage table
 * shows it; Export hands the server's CSV of the same groups to the share sheet.
 */
export default function DozoUsage() {
  const { t } = useLingui();
  const locale = dateLocaleForUi(useUiLocale());
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [chosen, setBy] = useState<DozoUsageGrouping>("model");
  // Only an owner whose Space has other members is offered the person grouping; if that stops
  // being true while it is open, the list falls back to the model grouping.
  const scope = useQuery(rpcQuery("dozoUsage/scope"), queryClient);
  const by = chosen === "person" && !scope.data?.person ? "model" : chosen;
  const groups = useQuery(
    { ...rpcQuery("dozoUsage/breakdown", { by }), placeholderData: keepPreviousData },
    queryClient,
  );
  const count = new Intl.NumberFormat(locale);
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const number = (value: number | null) => (value == null ? "—" : count.format(value));
  const cost = (value: number | null) =>
    value == null ? "—" : value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value);
  const dayFormat = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const name = (group: DozoUsageGroup) => {
    // The previous grouping stays on screen while this one loads, so its keys are not days yet.
    if (by === "day" && DAY_KEY.test(group.key))
      return dayFormat.format(new Date(`${group.key}T00:00:00Z`));
    if (group.state === "unknown") return t`Unknown`;
    if (group.state === "none") return by === "bot" ? t`No bot` : t`No routine`;
    return group.name ?? "—";
  };
  const about = (group: DozoUsageGroup) => (group.state === "deleted" ? t`Deleted` : group.detail);

  async function exportCsv() {
    try {
      const { csv } = await queryClient.fetchQuery({
        ...rpcQuery("dozoUsage/csv", { by }),
        staleTime: 0,
      });
      const day = dozoLocalDay(new Date());
      await Share.share({ message: csv, title: `usage-${by}-${day}.csv` });
    } catch (error) {
      Alert.alert(t`Could not export`, errorText(error, t`Try again.`));
    }
  }

  useScreenHeader({
    title: t`Usage`,
    action: groups.data?.length
      ? { label: t`Export`, prominence: "secondary", onPress: () => void exportCsv() }
      : null,
  });

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <NativeSegmentedControl
          accessibilityLabel={t`Group by`}
          onChange={setBy}
          options={[
            { value: "model", label: t`Model` },
            { value: "bot", label: t`Bot` },
            { value: "routine", label: t`Routine` },
            { value: "day", label: t`Day` },
            ...(scope.data?.person ? [{ value: "person" as const, label: t`Person` }] : []),
          ]}
          value={by}
        />
        {groups.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {errorText(groups.error, t`Something went wrong. Try again.`)}
          </Text>
        ) : null}
        <SettingsGroup>
          {groups.data?.map((group) => (
            <SettingsRow
              key={group.key}
              accessible
              dimmed={group.state !== "live"}
              title={name(group)}
              detail={[
                about(group),
                t`${ph({ calls: number(group.modelCalls) })} calls, ${ph({ tokens: number(group.totalTokens) })} tokens`,
              ]
                .filter(Boolean)
                .join(", ")}
              value={cost(group.costUsd)}
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
