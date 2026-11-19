import { useLingui } from "@lingui/react/macro";
import type { PlanEnd } from "@rakazo/contracts";
import { planEndDays, planEndWarns } from "@rakazo/contracts";
import { StyleSheet, Text, View } from "react-native";
import { dateLocaleForUi } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { SettingsRow } from "./settings-group";

/**
 * When the plan in force renews or ends, and the days left, in the warning colour near its end. A
 * granted plan above a subscription says which plan follows instead.
 */
export function DozoPlanEndRow({ end }: { end: PlanEnd }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const day = new Date(end.at).toLocaleDateString(dateLocaleForUi(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const count = planEndDays(end);
  const remaining = t`${count} days`;
  const left = end.fallsTo
    ? `${end.fallsTo.from} → ${end.fallsTo.to}`
    : count <= 0
      ? t`Today`
      : count === 1
        ? t`Tomorrow`
        : t`${remaining} left`;
  const color = planEndWarns(end) ? tokens.warning : native.secondaryLabel;
  return (
    <SettingsRow
      title={end.renews ? t`Renews` : t`Ends`}
      trailing={
        <View testID="plan-end" style={styles.end}>
          <Text style={[styles.text, { color }]}>{day}</Text>
          <Text testID="plan-end-left" style={[styles.left, { color }]}>
            {left}
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  end: { flexShrink: 1, alignItems: "flex-end" },
  text: { fontSize: 17 },
  left: { fontSize: 13 },
});
